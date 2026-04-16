/**
 * utils/similarity.js
 *
 * Cosine similarity and top-K retrieval over embedding vectors.
 * All embeddings are expected to be Float32Array or plain number arrays.
 */

/**
 * Computes the cosine similarity between two equal-length vectors.
 * Returns a value in [-1, 1]. Returns 0 for zero-length vectors.
 *
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Finds the top-K most similar chunks to a query embedding.
 *
 * @param {Float32Array|number[]} queryEmbedding
 * @param {Array<{text: string, start: number, embedding: Float32Array|number[]}>} chunks
 * @param {number} k  Number of results to return (default 5)
 * @returns {Array<{text: string, start: number, score: number}>}  Sorted descending by score
 */
export function topK(queryEmbedding, chunks, k = 5) {
  const scored = chunks.map(chunk => ({
    text: chunk.text,
    start: chunk.start,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
