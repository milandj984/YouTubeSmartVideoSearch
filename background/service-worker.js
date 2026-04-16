/**
 * background/service-worker.js
 *
 * Central orchestrator for the extension.
 *
 * Responsibilities:
 *  - Routing messages between popup, content scripts, and offscreen document
 *  - Managing the offscreen document lifecycle (one per extension)
 *  - Orchestrating the scan pipeline: transcript → chunk → embed → persist
 *  - Executing semantic search: embed query → load chunks → rank → return results
 *
 * Message API (received from popup):
 *  SCAN_VIDEO  { videoId, tabId, title? }
 *  SEARCH      { videoId, query }
 *  SEEK        { tabId, time }
 *  VIDEO_EXISTS { videoId }
 *  DELETE_VIDEO { videoId }
 */

import { chunkTranscript } from '../utils/chunker.js';
import { topK } from '../utils/similarity.js';
import {
  saveVideo,
  saveChunks,
  getChunksByVideoId,
  videoExists,
  deleteVideo,
  touchVideo,
  evictStaleVideos,
} from '../storage/db.js';

// ---------------------------------------------------------------------------
// Offscreen document management
// ---------------------------------------------------------------------------

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/offscreen.html');

/**
 * Ensures exactly one offscreen document exists.
 * Chrome allows only one per extension; reuses it if already open.
 *
 * Falls back gracefully on Chrome < 116 (where getContexts doesn't exist)
 * by attempting to create and ignoring "already exists" errors.
 */
async function ensureOffscreenDocument() {
  // chrome.runtime.getContexts was introduced in Chrome 116
  if (chrome.runtime.getContexts) {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [OFFSCREEN_URL],
    });
    if (existingContexts.length > 0) return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification: 'Run all-MiniLM-L6-v2 ONNX model for semantic embeddings',
    });
  } catch (err) {
    // "Only a single offscreen document may be created" means it's already there
    if (!err.message?.includes('Only a single')) {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Offscreen messaging helpers
// ---------------------------------------------------------------------------

/**
 * Sends a message to the offscreen document and awaits a response.
 * Automatically ensures the document is created first.
 *
 * @param {object} message
 * @returns {Promise<object>}
 */
async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage(message);
}

/**
 * Embeds an array of text chunks via the offscreen ONNX pipeline.
 *
 * @param {Array<{text: string, start: number}>} chunks
 * @returns {Promise<Array<{text: string, start: number, embedding: number[]}>>}
 */
async function embedChunks(chunks) {
  const response = await sendToOffscreen({ type: 'EMBED_CHUNKS', chunks });
  if (response?.error) throw new Error(response.error);
  return response.chunks;
}

/**
 * Embeds a single query string.
 *
 * @param {string} query
 * @returns {Promise<number[]>}
 */
async function embedQuery(query) {
  const response = await sendToOffscreen({ type: 'EMBED_QUERY', query });
  if (response?.error) throw new Error(response.error);
  return response.embedding;
}

// ---------------------------------------------------------------------------
// Content script messaging helpers
// ---------------------------------------------------------------------------

/**
 * Sends a message to the content script in the given tab and returns the response.
 *
 * @param {number} tabId
 * @param {object} message
 * @returns {Promise<object>}
 */
function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

// ---------------------------------------------------------------------------
// Scan pipeline
// ---------------------------------------------------------------------------

/**
 * Full scan pipeline:
 *   1. Fetch transcript from content script
 *   2. Chunk into ~70-word overlapping segments
 *   3. Embed all chunks (ONNX pipeline in offscreen document)
 *   4. Persist chunks + video metadata in IndexedDB
 *
 * Sends SCAN_PROGRESS messages back to the popup during embedding.
 *
 * @param {{ videoId: string, tabId: number, title?: string }} params
 * @param {function} sendResponse  Popup's sendResponse callback
 */
async function handleScanVideo({ videoId, tabId, title }, sendResponse) {
  try {
    // Step 1: Get transcript
    sendProgressToPopup({ stage: 'transcript', message: 'Fetching transcript…' });

    const transcriptResponse = await sendToTab(tabId, { type: 'GET_TRANSCRIPT' });

    if (transcriptResponse?.error) {
      const isNoTranscript = transcriptResponse.errorName === 'NoTranscriptError';
      sendResponse({
        type: 'SCAN_ERROR',
        noTranscript: isNoTranscript,
        message: transcriptResponse.error,
      });
      return;
    }

    const { transcript } = transcriptResponse;

    // Step 2: Chunk
    sendProgressToPopup({ stage: 'chunking', message: 'Chunking transcript…' });
    const chunks = chunkTranscript(transcript);

    if (chunks.length === 0) {
      sendResponse({ type: 'SCAN_ERROR', noTranscript: true, message: 'Transcript is empty.' });
      return;
    }

    // Step 3: Embed (progress relayed via EMBED_PROGRESS messages from offscreen)
    sendProgressToPopup({
      stage: 'embedding',
      message: `Embedding ${chunks.length} chunks…`,
      total: chunks.length,
      done: 0,
    });

    const embeddedChunks = await embedChunks(chunks);

    // Step 4: Persist
    sendProgressToPopup({ stage: 'saving', message: 'Saving to cache…' });
    await saveChunks(videoId, embeddedChunks);
    await saveVideo({ videoId, title: title ?? '', chunkCount: chunks.length });

    // Evict stale/excess videos after each scan (fire-and-forget, non-blocking)
    evictStaleVideos().catch(err => console.warn('[SW] Eviction error:', err));

    sendResponse({
      type: 'SCAN_COMPLETE',
      chunkCount: chunks.length,
    });
  } catch (err) {
    console.error('[SW] Scan error:', err);
    sendResponse({ type: 'SCAN_ERROR', message: err.message });
  }
}

// ---------------------------------------------------------------------------
// Search pipeline
// ---------------------------------------------------------------------------

/**
 * @param {{ videoId: string, query: string }} params
 * @param {function} sendResponse
 */
async function handleSearch({ videoId, query }, sendResponse) {
  try {
    const [queryEmbedding, chunks] = await Promise.all([
      embedQuery(query),
      getChunksByVideoId(videoId),
    ]);

    if (chunks.length === 0) {
      sendResponse({ type: 'SEARCH_RESULT', results: [] });
      return;
    }

    const results = topK(queryEmbedding, chunks, 5);

    // Update lastAccessedAt so this video is not evicted as long as it's used
    touchVideo(videoId).catch(() => {});

    sendResponse({ type: 'SEARCH_RESULT', results });
  } catch (err) {
    console.error('[SW] Search error:', err);
    sendResponse({ type: 'SEARCH_ERROR', message: err.message });
  }
}

// ---------------------------------------------------------------------------
// Seek handler
// ---------------------------------------------------------------------------

async function handleSeek({ tabId, time }, sendResponse) {
  try {
    const result = await sendToTab(tabId, { type: 'SEEK', time });
    sendResponse({ type: 'SEEK_RESULT', success: result?.success ?? false });
  } catch (err) {
    sendResponse({ type: 'SEEK_ERROR', message: err.message });
  }
}

// ---------------------------------------------------------------------------
// Popup progress relay
// ---------------------------------------------------------------------------

/**
 * Broadcasts a progress update to all extension popup pages.
 * The popup listens for these to update its progress bar.
 */
function sendProgressToPopup(progress) {
  chrome.runtime.sendMessage({ type: 'SCAN_PROGRESS', ...progress }).catch(() => {
    // Popup may not be open; safe to ignore
  });
}

// ---------------------------------------------------------------------------
// Main message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Route messages that originate from the offscreen document's EMBED_PROGRESS
  // back to the popup (the popup registers its own listener for this)
  if (message.type === 'EMBED_PROGRESS') {
    sendProgressToPopup({
      stage: 'embedding',
      done: message.done,
      total: message.total,
      message: `Embedding chunks… (${message.done}/${message.total})`,
    });
    return false; // No async response needed
  }

  switch (message.type) {
    case 'SCAN_VIDEO':
      handleScanVideo(message, sendResponse);
      return true; // Async

    case 'SEARCH':
      handleSearch(message, sendResponse);
      return true;

    case 'SEEK':
      handleSeek(message, sendResponse);
      return true;

    case 'VIDEO_EXISTS':
      videoExists(message.videoId)
        .then(exists => sendResponse({ exists }))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'DELETE_VIDEO':
      deleteVideo(message.videoId)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    default:
      return false;
  }
});
