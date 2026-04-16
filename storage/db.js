/**
 * storage/db.js
 *
 * IndexedDB wrapper for the extension.
 *
 * Schema (v2)
 * ───────────
 * DB name : YTSmartSearch
 *
 * Store: videos
 *   keyPath   : videoId  (string, e.g. "dQw4w9WgXcQ")
 *   index     : lastAccessedAt (for LRU eviction ordering)
 *   fields    : videoId, title, processedAt (ISO string), lastAccessedAt (ISO string), chunkCount
 *
 * Store: chunks
 *   keyPath   : id  (auto-increment integer)
 *   index     : videoId  (non-unique)
 *   fields    : id, videoId, text, start (seconds, number), embedding (Float32Array serialised as Array)
 *
 * Embeddings are stored as plain Arrays (JSON-serialisable).
 * They are reconstituted as Float32Array on retrieval.
 *
 * Eviction policy (LRU + TTL)
 * ────────────────────────────
 * After every scan, evictStaleVideos() is called automatically.
 * It removes:
 *   1. Any video not accessed in the last MAX_AGE_DAYS days.
 *   2. The oldest-accessed videos beyond the MAX_VIDEOS limit.
 *
 * lastAccessedAt is updated on every search (touchVideo), so frequently
 * re-used videos stay alive regardless of their original scan date.
 */

const DB_NAME = 'YTSmartSearch';
const DB_VERSION = 2; // bumped from v1 to add lastAccessedAt index

// ---------------------------------------------------------------------------
// Eviction policy constants
// ---------------------------------------------------------------------------

/** Maximum number of videos to keep in cache. */
const MAX_VIDEOS = 50;

/** Videos not accessed within this many days are removed. */
const MAX_AGE_DAYS = 30;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const oldVersion = event.oldVersion;

      // v1 → create base stores
      if (oldVersion < 1) {
        db.createObjectStore('videos', { keyPath: 'videoId' });
        const chunkStore = db.createObjectStore('chunks', {
          keyPath: 'id',
          autoIncrement: true,
        });
        chunkStore.createIndex('videoId', 'videoId', { unique: false });
      }

      // v2 → add lastAccessedAt index on the videos store
      if (oldVersion < 2) {
        const tx = event.target.transaction;
        const videoStore = tx.objectStore('videos');
        if (!videoStore.indexNames.contains('lastAccessedAt')) {
          videoStore.createIndex('lastAccessedAt', 'lastAccessedAt', { unique: false });
        }
      }
    };

    request.onsuccess = (event) => {
      _db = event.target.result;
      resolve(_db);
    };

    request.onerror = (event) => {
      reject(new Error(`IndexedDB open error: ${event.target.error}`));
    };
  });
}

// ---------------------------------------------------------------------------
// videos store
// ---------------------------------------------------------------------------

/**
 * Persists metadata for a processed video.
 * Sets both processedAt and lastAccessedAt to now.
 *
 * @param {{videoId: string, title: string, chunkCount: number}} meta
 */
export async function saveVideo(meta) {
  const db = await openDB();
  const now = new Date().toISOString();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readwrite');
    tx.objectStore('videos').put({
      videoId: meta.videoId,
      title: meta.title ?? '',
      processedAt: now,
      lastAccessedAt: now,
      chunkCount: meta.chunkCount,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Updates lastAccessedAt for a video to the current time.
 * Call this whenever a user searches within a cached video so that
 * actively-used videos survive LRU eviction.
 *
 * @param {string} videoId
 */
export async function touchVideo(videoId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readwrite');
    const store = tx.objectStore('videos');
    const req = store.get(videoId);
    req.onsuccess = (e) => {
      const record = e.target.result;
      if (record) {
        record.lastAccessedAt = new Date().toISOString();
        store.put(record);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Returns true if the video has already been processed and cached.
 * @param {string} videoId
 * @returns {Promise<boolean>}
 */
export async function videoExists(videoId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const req = tx.objectStore('videos').get(videoId);
    req.onsuccess = (e) => resolve(!!e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Retrieves video metadata.
 * @param {string} videoId
 * @returns {Promise<object|null>}
 */
export async function getVideo(videoId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const req = tx.objectStore('videos').get(videoId);
    req.onsuccess = (e) => resolve(e.target.result ?? null);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Deletes a video and all its associated chunks.
 * @param {string} videoId
 */
export async function deleteVideo(videoId) {
  const db = await openDB();

  // Delete chunks first (index-based delete)
  await new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    const index = tx.objectStore('chunks').index('videoId');
    const req = index.openCursor(IDBKeyRange.only(videoId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });

  // Then delete the video record
  await new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readwrite');
    tx.objectStore('videos').delete(videoId);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ---------------------------------------------------------------------------
// chunks store
// ---------------------------------------------------------------------------

/**
 * Saves all chunks for a video in a single transaction.
 *
 * @param {string} videoId
 * @param {Array<{text: string, start: number, embedding: Float32Array|number[]}>} chunks
 */
export async function saveChunks(videoId, chunks) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    const store = tx.objectStore('chunks');

    for (const chunk of chunks) {
      store.add({
        videoId,
        text: chunk.text,
        start: chunk.start,
        // Store as plain Array for JSON serialisability
        embedding: Array.from(chunk.embedding),
      });
    }

    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Retrieves all chunks for a video.
 * Embeddings are reconstituted as Float32Array.
 *
 * @param {string} videoId
 * @returns {Promise<Array<{text: string, start: number, embedding: Float32Array}>>}
 */
export async function getChunksByVideoId(videoId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readonly');
    const index = tx.objectStore('chunks').index('videoId');
    const req = index.getAll(IDBKeyRange.only(videoId));

    req.onsuccess = (e) => {
      const rows = e.target.result;
      const chunks = rows.map(row => ({
        text: row.text,
        start: row.start,
        embedding: new Float32Array(row.embedding),
      }));
      resolve(chunks);
    };

    req.onerror = (e) => reject(e.target.error);
  });
}

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

/**
 * Retrieves all video metadata records, sorted by lastAccessedAt ascending
 * (oldest first — these are the eviction candidates).
 *
 * @returns {Promise<Array<object>>}
 */
async function getAllVideosSortedByAccess() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const index = tx.objectStore('videos').index('lastAccessedAt');
    const req = index.getAll();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Evicts stale videos from the cache according to two rules (applied in order):
 *
 *  1. TTL: Remove any video whose lastAccessedAt is older than MAX_AGE_DAYS.
 *  2. LRU cap: If more than MAX_VIDEOS remain, remove the least-recently-used
 *     ones until the count is at MAX_VIDEOS.
 *
 * Both chunk records and video metadata are deleted together.
 * This is safe to call after every scan; it is a no-op when within limits.
 *
 * @returns {Promise<number>}  Number of videos evicted.
 */
export async function evictStaleVideos() {
  const all = await getAllVideosSortedByAccess(); // oldest first
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_AGE_DAYS);

  const toDelete = new Set();

  // Rule 1: TTL — remove videos not accessed within MAX_AGE_DAYS
  for (const video of all) {
    const lastAccessed = new Date(video.lastAccessedAt ?? video.processedAt);
    if (lastAccessed < cutoff) {
      toDelete.add(video.videoId);
    }
  }

  // Rule 2: LRU cap — trim oldest until we're within MAX_VIDEOS
  const surviving = all.filter(v => !toDelete.has(v.videoId));
  const excess = surviving.length - MAX_VIDEOS;
  if (excess > 0) {
    // surviving is already sorted oldest-first
    for (let i = 0; i < excess; i++) {
      toDelete.add(surviving[i].videoId);
    }
  }

  for (const videoId of toDelete) {
    await deleteVideo(videoId);
  }

  if (toDelete.size > 0) {
    console.log(`[YTSmartSearch] Evicted ${toDelete.size} cached video(s) (policy: TTL=${MAX_AGE_DAYS}d, max=${MAX_VIDEOS}).`);
  }

  return toDelete.size;
}

/**
 * Returns a summary of the current cache for display in the popup (optional).
 * @returns {Promise<{count: number, oldestAccess: string|null, newestAccess: string|null}>}
 */
export async function getCacheStats() {
  const all = await getAllVideosSortedByAccess();
  return {
    count: all.length,
    oldestAccess: all[0]?.lastAccessedAt ?? null,
    newestAccess: all[all.length - 1]?.lastAccessedAt ?? null,
  };
}
