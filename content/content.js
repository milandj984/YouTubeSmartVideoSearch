/**
 * content/content.js
 *
 * Entry point for all content-script-side messaging.
 * Listens for messages from the background service worker and dispatches
 * them to the appropriate module (player.js).
 *
 * Supported message types:
 *   SEEK → player.js seekTo(time)
 */

// content.js runs after transcript.js and player.js (declared first in manifest)
// so their exported functions are available on the window namespace bridge below.
// Because content scripts don't share a module scope across files loaded by the
// manifest, we use a simple pattern: attach the API to a shared namespace object.

// ---------------------------------------------------------------------------
// Shared namespace (populated by transcript.js and player.js via window)
// ---------------------------------------------------------------------------
// NOTE: In MV3 manifest-injected content scripts, each file runs in the same
// content script execution context, but they are plain scripts (not ES modules).
// We therefore expose functions via window and guard against re-declaration.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(err => {
      sendResponse({ error: err.message, errorName: err.name });
    });

  // Must return true to keep the message channel open for async sendResponse
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'SEEK': {
      const success = window.__ytSearch.seekTo(message.time);
      return { type: 'SEEK_RESULT', success };
    }

    case 'TOGGLE_PLAYBACK': {
      const state = window.__ytSearch.togglePlayback();
      return { type: 'TOGGLE_PLAYBACK_RESULT', state };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}
