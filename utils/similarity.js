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

/** Minimum cosine similarity to be considered a relevant match. */
const COSINE_THRESHOLD = 0.25;

/**
 * Finds the top-K most similar chunks to a query embedding.
 * Chunks below COSINE_THRESHOLD are excluded as irrelevant.
 *
 * @param {Float32Array|number[]} queryEmbedding
 * @param {Array<{text: string, start: number, embedding: Float32Array|number[]}>} chunks
 * @param {number} k
 * @returns {Array<{text: string, start: number, score: number}>}
 */
export function topK(queryEmbedding, chunks, k = 5) {
  const scored = chunks
    .map(chunk => ({
      text: chunk.text,
      start: chunk.start,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))
    .filter(c => c.score >= COSINE_THRESHOLD);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** Escapes regex metacharacters in a string for safe use inside RegExp(). */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Full-text search using whole-word token matching (not substring).
 * Ranked by fraction of query tokens matched + verbatim phrase bonus.
 *
 * @param {string} query
 * @param {Array<{text: string, start: number}>} chunks
 * @param {number} k
 * @returns {Array<{text: string, start: number, score: number}>}
 */
export function fullTextSearch(query, chunks, k = 5) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  // Pre-compile regexes once outside the chunk loop; escape metacharacters to
  // prevent RegExp injection from user-supplied query text (e.g. "c++", "[test]").
  const tokenRes = tokens.map(t => new RegExp(`(?<![a-z0-9])${escapeRe(t)}(?![a-z0-9])`));
  const lowerQuery = query.toLowerCase();

  const scored = [];
  for (const chunk of chunks) {
    const lower = chunk.text.toLowerCase();
    // Whole-word match: token must be surrounded by non-word chars or string boundaries
    const matched = tokenRes.filter(re => re.test(lower)).length;
    if (matched === 0) continue;
    const density = matched / tokens.length;
    const verbatim = lower.includes(lowerQuery) ? 0.5 : 0;
    scored.push({ text: chunk.text, start: chunk.start, score: density + verbatim });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Merges semantic and full-text result lists using Reciprocal Rank Fusion,
 * then replaces each result's score with its actual cosine similarity so the
 * displayed percentage reflects real relevance rather than rank position.
 *
 * @param {Array<{text: string, start: number, score: number}>} semanticResults  (score = cosine)
 * @param {Array<{text: string, start: number, score: number}>} textResults
 * @param {number} topN
 * @returns {Array<{text: string, start: number, score: number}>}
 */
export function hybridSearch(semanticResults, textResults, topN = 5) {
  // Build cosine lookup by start time
  const cosineByStart = new Map(semanticResults.map(r => [r.start, r.score]));

  const rrfK = 60;
  const rrfScores = new Map();

  for (const list of [semanticResults, textResults]) {
    list.forEach((item, rank) => {
      const rrf = 1 / (rrfK + rank + 1);
      if (rrfScores.has(item.start)) {
        rrfScores.get(item.start).rrfScore += rrf;
      } else {
        rrfScores.set(item.start, { text: item.text, start: item.start, rrfScore: rrf });
      }
    });
  }

  const merged = Array.from(rrfScores.values())
    // Only include results that passed the cosine threshold — text search boosts rank only
    .filter(item => cosineByStart.has(item.start));

  merged.sort((a, b) => b.rrfScore - a.rrfScore);

  return merged.slice(0, topN).map(item => ({
    text: item.text,
    start: item.start,
    score: cosineByStart.get(item.start),
  }));
}
