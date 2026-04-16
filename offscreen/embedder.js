/**
 * offscreen/embedder.js
 *
 * Runs inside Chrome's offscreen document context (WASM-safe).
 * Lazily initialises the all-MiniLM-L6-v2 feature-extraction pipeline
 * from locally bundled model files, then handles embedding requests from
 * the background service worker.
 *
 * Messages received:
 *   { type: 'EMBED_CHUNKS', chunks: [{text, start}] }
 *     → replies { type: 'EMBED_CHUNKS_RESULT', chunks: [{text, start, embedding: number[]}] }
 *
 *   { type: 'EMBED_QUERY', query: string }
 *     → replies { type: 'EMBED_QUERY_RESULT', embedding: number[] }
 *
 *   { type: 'PING' }
 *     → replies { type: 'PONG' }
 */

import { pipeline, env } from '@xenova/transformers';

// ---------------------------------------------------------------------------
// Configure transformers.js to use bundled local models (fully offline)
// ---------------------------------------------------------------------------

env.allowRemoteModels = false;
env.allowLocalModels = true;

// Point to the models/ folder inside the extension package.
// chrome.runtime.getURL resolves to the extension's origin at runtime.
env.localModelPath = chrome.runtime.getURL('models/');

// ONNX WASM binaries are co-located with the bundled embedder in dist/offscreen/
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('offscreen/');

// ---------------------------------------------------------------------------
// Lazy pipeline singleton
// ---------------------------------------------------------------------------

let _pipelinePromise = null;
let _initProgress = 0;

function getEmbeddingPipeline() {
  if (!_pipelinePromise) {
    _pipelinePromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
      progress_callback: (progress) => {
        // progress is { status, name, file, progress, loaded, total }
        if (progress.status === 'progress' && progress.total > 0) {
          _initProgress = Math.round((progress.loaded / progress.total) * 100);
        }
      },
    });
  }
  return _pipelinePromise;
}

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

/**
 * Embeds a single string and returns a plain number[].
 * Mean-pooled + L2-normalised (standard for sentence similarity).
 *
 * @param {object} pipe  Transformers.js pipeline instance
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedText(pipe, text) {
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  // output.data is a Float32Array; convert to plain Array for transfer
  return Array.from(output.data);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));

  // Return true to signal async sendResponse
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'PING':
      return { type: 'PONG' };

    case 'EMBED_QUERY': {
      const pipe = await getEmbeddingPipeline();
      const embedding = await embedText(pipe, message.query);
      return { type: 'EMBED_QUERY_RESULT', embedding };
    }

    case 'EMBED_CHUNKS': {
      const pipe = await getEmbeddingPipeline();
      const { chunks } = message;
      const result = [];

      for (let i = 0; i < chunks.length; i++) {
        const embedding = await embedText(pipe, chunks[i].text);
        result.push({
          text: chunks[i].text,
          start: chunks[i].start,
          embedding,
        });

        // Notify progress every 5 chunks so the popup can show a progress bar
        if ((i + 1) % 5 === 0 || i === chunks.length - 1) {
          chrome.runtime.sendMessage({
            type: 'EMBED_PROGRESS',
            done: i + 1,
            total: chunks.length,
          }).catch(() => {
            // Popup may have closed; ignore the error
          });
        }
      }

      return { type: 'EMBED_CHUNKS_RESULT', chunks: result };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}
