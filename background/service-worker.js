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
import { topK, fullTextSearch, hybridSearch } from '../utils/similarity.js';
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
  if (!response?.embedding) throw new Error('No embedding returned from offscreen document.');
  return response.embedding;
}

// ---------------------------------------------------------------------------
// Content script messaging helpers
// ---------------------------------------------------------------------------

/** Content script files — must match the order declared in manifest.json. */
const CONTENT_SCRIPTS = [
  'content/player.js',
  'content/content.js',
];

/**
 * Injects the content scripts into a tab programmatically.
 * Used as a fallback when the scripts weren't auto-injected (e.g. the tab
 * was already open when the extension was installed or reloaded).
 *
 * @param {number} tabId
 */
async function injectContentScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPTS,
  });
}

/**
 * Sends a message to the content script in the given tab.
 * If the content script isn't present yet, injects it first then retries once.
 *
 * @param {number} tabId
 * @param {object} message
 * @returns {Promise<object>}
 */
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    const isNotFound = err.message?.includes('Receiving end does not exist') ||
                       err.message?.includes('Could not establish connection');
    if (!isNotFound) throw err;

    // Content script not present — inject it now, then retry
    await injectContentScripts(tabId);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// ---------------------------------------------------------------------------
// Transcript fetching
// ---------------------------------------------------------------------------

/**
 * Opens YouTube's built-in transcript panel via executeScript in MAIN world,
 * then reads the already-rendered segment elements from the DOM.
 * No fetch calls — bypasses YouTube's SW interception entirely.
 */
async function fetchTranscriptViaPageScript(videoId, tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        try {
          const parseTime = (s) => {
            const parts = s.trim().split(':').map(Number);
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            if (parts.length === 2) return parts[0] * 60 + parts[1];
            return 0;
          };

          const readSegments = () => {
            const segs = document.querySelectorAll('ytd-transcript-segment-renderer');
            if (!segs.length) return null;
            const entries = [];
            for (const seg of segs) {
              const timeEl = seg.querySelector('.segment-timestamp');
              const textEl = seg.querySelector('.segment-text');
              const timeStr = (timeEl?.textContent || '').trim();
              const text = (textEl?.textContent || '').trim();
              if (!timeStr || !text) continue;
              entries.push({ text, start: parseTime(timeStr) });
            }
            return entries.length ? entries : null;
          };

          // If the panel is already open, just read it
          const existing = readSegments();
          if (existing) {
            return { entries: existing };
          }

          // Try to open the transcript panel
          let method = 'none';

          // Method 1: click the "Show transcript" button in the description
          const btn = document.querySelector(
            'ytd-video-description-transcript-section-renderer button, ' +
            'button[aria-label*="ranscript" i], [role="button"][aria-label*="ranscript" i]'
          );
          if (btn) {
            btn.click();
            method = 'btn-click';
          } else {
            // Method 2: dispatch YouTube's internal engagement-panel action
            const app = document.querySelector('ytd-app');
            if (app) {
              app.dispatchEvent(new CustomEvent('yt-action', {
                bubbles: true,
                composed: true,
                detail: {
                  actionName: 'yt-update-engagement-panel-action',
                  args: [{ targetId: 'engagement-panel-searchable-transcript', visibility: 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' }],
                },
              }));
              method = 'yt-action';
            }
          }
          
          // Poll up to 10 s for segments to appear
          const segments = await new Promise(resolve => {
            let tries = 0;
            const timer = setInterval(() => {
              const segs = document.querySelectorAll('ytd-transcript-segment-renderer');
              if (segs.length > 0 || ++tries >= 50) { clearInterval(timer); resolve(segs); }
            }, 200);
          });

          if (!segments.length) return { error: `no-dom-segments (${method})` };

          const entries = readSegments();

          // Close the panel we opened. Only close if we were the ones who opened it.
          // YouTube uses Polymer property observers — setting the JS property directly
          // on the element triggers the visibility change, unlike setAttribute().
          if (method !== 'none') {
            const panel = document.querySelector(
              'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
            );
            if (panel) {
              panel.visibility = 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN';
            }
          }

          return entries ? { entries } : { error: 'dom-empty-entries' };
        } catch (e) {
          return { error: e.message };
        }
      },
    });
  } catch (e) {
    return null;
  }

  const result = results?.[0]?.result;
  if (!result || result.error) {
    return null;
  }
  return result.entries || null;
}

/**
 * Fetches the full transcript for a video.
 * Uses executeScript into the page's MAIN world to open YouTube's own transcript
 * panel and read the already-rendered segment elements — no network fetch needed.
 */
async function fetchTranscriptForVideo(videoId, tabId) {
  const entries = await fetchTranscriptViaPageScript(videoId, tabId);
  if (entries && entries.length > 0) return entries;

  const err = new Error('This video does not have captions/subtitles available.');
  err.name = 'NoTranscriptError';
  throw err;
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
    // Step 1: Get transcript — fetched in background SW, bypasses YouTube's own SW
    sendProgressToPopup({ stage: 'transcript', message: 'Fetching transcript…' });

    let transcript;
    try {
      transcript = await fetchTranscriptForVideo(videoId, tabId);
    } catch (err) {
      sendResponse({
        type: 'SCAN_ERROR',
        noTranscript: err.name === 'NoTranscriptError',
        message: err.message + (err.diagnostics ? ' | diag: ' + err.diagnostics.join(' | ') : ''),
      });
      return;
    }

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

    const semanticResults = topK(queryEmbedding, chunks, 5);
    const textResults = fullTextSearch(query, chunks, 5);
    const results = hybridSearch(semanticResults, textResults, 5);

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

    case 'TOGGLE_PLAYBACK':
      sendToTab(message.tabId, { type: 'TOGGLE_PLAYBACK' })
        .then(result => sendResponse({ type: 'TOGGLE_PLAYBACK_RESULT', state: result?.state }))
        .catch(err => sendResponse({ error: err.message }));
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
