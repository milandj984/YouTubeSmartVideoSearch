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
 *
 * Note: direct fetch of YouTube's timedtext API URLs is blocked by YouTube's
 * own service worker (returns empty HTML), so DOM scraping is the only viable
 * approach from within the page context.
 */
async function fetchTranscriptViaPageScript(videoId, tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        // Panel target-ids YouTube has used for the transcript panel.
        // 'PAmodern_transcript_view' is the current id (2025+).
        // 'engagement-panel-searchable-transcript' is the legacy id kept as fallback.
        const PANEL_IDS = [
          'PAmodern_transcript_view',
          'engagement-panel-searchable-transcript',
        ];
        const PANEL_SEL = PANEL_IDS
          .map(id => `ytd-engagement-panel-section-list-renderer[target-id="${id}"]`)
          .join(', ');

        const findOpenPanel = () => {
          for (const id of PANEL_IDS) {
            const el = document.querySelector(
              `ytd-engagement-panel-section-list-renderer[target-id="${id}"]`
            );
            // Polymer sets .visibility as a JS property, not always as an attribute
            if (el && el.visibility !== 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN') return el;
          }
          // Fallback: any panel with the word "transcript" in its target-id that is visible
          const all = document.querySelectorAll('ytd-engagement-panel-section-list-renderer');
          for (const el of all) {
            if ((el.getAttribute('target-id') || '').toLowerCase().includes('transcript') &&
                el.visibility !== 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN') return el;
          }
          return null;
        };

        // ── Helper: close the transcript engagement panel ─────────────────────
        const closePanel = () => {
          const panel = findOpenPanel() ||
            document.querySelector(PANEL_SEL);
          if (panel) panel.visibility = 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN';
        };

        try {
          const parseTime = (s) => {
            const parts = s.trim().split(':').map(Number);
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            if (parts.length === 2) return parts[0] * 60 + parts[1];
            return 0;
          };

          // Segment element selectors, newest YouTube UI first.
          // transcript-segment-view-model  — 2025+ "PAmodern_transcript_view" panel
          // ytd-transcript-segment-renderer — legacy panel
          const SEG_SELECTORS = [
            'transcript-segment-view-model',
            'ytd-transcript-segment-renderer',
          ];

          const anySegments = () =>
            document.querySelector(SEG_SELECTORS.join(', '));

          const readSegments = () => {
            for (const sel of SEG_SELECTORS) {
              const segs = document.querySelectorAll(sel);
              if (!segs.length) continue;

              const entries = [];

              if (sel === 'transcript-segment-view-model') {
                // New panel: each element's innerText looks like:
                //   "0:07\n7 seconds\nKnowing the difference…"
                //   or "0:00\n99% of developers…"
                // The "N seconds" line is a duration label — strip it.
                for (const seg of segs) {
                  const raw = (seg.innerText || seg.textContent || '').trim();
                  const match = raw.match(/^(\d+:\d{2}(?::\d{2})?)\s*([\s\S]*)/);
                  if (!match) continue;
                  const timeStr = match[1];
                  const body = match[2]
                    .replace(/^\d+\s+seconds?\s*/i, '') // strip leading "N seconds"
                    .trim();
                  if (body) entries.push({ text: body, start: parseTime(timeStr) });
                }
              } else {
                // Legacy panel: dedicated timestamp/text child elements
                for (const seg of segs) {
                  const timeEl = seg.querySelector('.segment-timestamp');
                  const textEl = seg.querySelector('.segment-text');
                  const timeStr = (timeEl?.textContent || '').trim();
                  const text = (textEl?.textContent || '').trim();
                  if (!timeStr || !text) continue;
                  entries.push({ text, start: parseTime(timeStr) });
                }
              }

              return entries.length ? entries : null;
            }
            return null;
          };

          // If the panel is already open, just read it
          const existing = readSegments();
          if (existing) return { entries: existing, method: 'dom-existing' };

          // Try to open the transcript panel by clicking the real "Show transcript"
          // button. This is the only approach that triggers YouTube's authenticated
          // continuation fetch — synthetic events open the panel UI but leave the
          // data fetch unstarted (spinner never resolves).
          let domMethod = 'none';

          const findTranscriptBtn = () => document.querySelector(
            'ytd-video-description-transcript-section-renderer button, ' +
            'button[aria-label*="ranscript" i], [role="button"][aria-label*="ranscript" i]'
          );

          let btn = findTranscriptBtn();
          let didExpand = false;

          if (!btn) {
            // The button lives inside the description section which YouTube
            // collapses by default. Expand it so the button is rendered.
            const expandBtn = document.querySelector(
              'tp-yt-paper-button#expand, ' +
              '#description-inline-expander [id="expand"], ' +
              'ytd-text-inline-expander [id="expand"], ' +
              '#snippet [id="expand"]'
            );
            if (expandBtn) {
              expandBtn.click();
              didExpand = true;
              // Give Polymer a moment to render the newly visible content
              await new Promise(r => setTimeout(r, 400));
              btn = findTranscriptBtn();
            }
          }

          if (btn) {
            btn.click();
            domMethod = didExpand ? 'btn-click-after-expand' : 'btn-click';
          } else {
            // Last resort: synthetic engagement-panel event.
            // Try the current panel ID first, then the legacy one.
            // Content may not load if YouTube's SW blocks the continuation.
            const app = document.querySelector('ytd-app');
            if (app) {
              for (const targetId of PANEL_IDS) {
                app.dispatchEvent(new CustomEvent('yt-action', {
                  bubbles: true,
                  composed: true,
                  detail: {
                    actionName: 'yt-update-engagement-panel-action',
                    args: [{ targetId, visibility: 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' }],
                  },
                }));
              }
              domMethod = 'yt-action-fallback';
            }
          }

          // Poll up to 30 s for segments to appear.
          // Strategy: wait for the spinner to disappear first (signals content loaded
          // or failed), then check for segments. This handles slow-loading transcripts
          // without always waiting the full timeout when content truly isn't there.
          const isSpinnerActive = () => {
            const p = findOpenPanel();
            return p ? !!p.querySelector('tp-yt-paper-spinner, ytd-continuation-item-renderer') : false;
          };

          const segments = await new Promise(resolve => {
            let tries = 0;
            const maxTries = 150; // 30 s at 200 ms intervals
            const timer = setInterval(() => {
              if (anySegments()) {
                clearInterval(timer);
                resolve(true);
                return;
              }
              // If spinner is gone and we've waited at least 1 s, content won't appear
              if (tries > 5 && !isSpinnerActive()) {
                clearInterval(timer);
                resolve(false);
                return;
              }
              if (++tries >= maxTries) {
                clearInterval(timer);
                resolve(false);
              }
            }, 200);
          });

          // Always close the panel, even on failure — avoids leaving it open in the UI
          if (domMethod !== 'none') closePanel();

          if (!segments) {
            return {
              error: `no-captions-available`,
              diagnostics: `no-dom-segments (${domMethod})`,
            };
          }

          const domEntries = readSegments();
          return domEntries
            ? { entries: domEntries, method: domMethod }
            : { error: 'no-captions-available', diagnostics: `dom-empty-entries (${domMethod})` };

        } catch (e) {
          return { error: e.message };
        }
      },
    });
  } catch (e) {
    console.error('[SW] executeScript failed:', e);
    return null;
  }

  const result = results?.[0]?.result;
  if (!result) return null;

  if (result.error) {
    // Surface diagnostics to the caller so the error message can be informative
    if (result.diagnostics) {
      console.warn(`[SW] Transcript fetch failed for ${videoId}: ${result.diagnostics}`);
    }
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
    // Step 1: Get transcript via DOM scraping in the YouTube tab
    sendProgressToPopup({ stage: 'transcript', message: 'Fetching transcript…' });

    let transcript;
    try {
      transcript = await fetchTranscriptForVideo(videoId, tabId);
    } catch (err) {
      sendResponse({
        type: 'SCAN_ERROR',
        noTranscript: err.name === 'NoTranscriptError',
        message: err.message,
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

/**
 * @param {{ tabId: number, time: number }} params
 * @param {function} sendResponse
 */
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
      message: `Scanning…`,
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

    case 'GET_PLAYBACK_STATE':
      sendToTab(message.tabId, { type: 'GET_PLAYBACK_STATE' })
        .then(result => sendResponse({ state: result?.state ?? 'playing' }))
        .catch(() => sendResponse({ state: 'playing' }));
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
