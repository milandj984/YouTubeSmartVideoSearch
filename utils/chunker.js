/**
 * utils/chunker.js
 *
 * Converts a flat transcript entry array into overlapping text chunks
 * suitable for embedding. Each chunk is ~60-80 words with a sliding window
 * to preserve context across boundaries.
 *
 * @param {Array<{text: string, start: number}>} entries  Raw transcript entries
 * @param {number} maxWords    Target max words per chunk (default 70)
 * @param {number} overlapWords  Words shared between adjacent chunks (default 15)
 * @returns {Array<{text: string, start: number}>}
 */
export function chunkTranscript(entries, maxWords = 70, overlapWords = 15) {
  if (!entries || entries.length === 0) return [];

  // Normalise: split each entry's text into individual word tokens
  // keeping track of the start time for the first token from each entry.
  const tokens = []; // [{word, start}]
  for (const entry of entries) {
    const words = entry.text.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      tokens.push({ word: words[i], start: entry.start });
    }
  }

  if (tokens.length === 0) return [];

  const chunks = [];
  let position = 0;

  while (position < tokens.length) {
    const slice = tokens.slice(position, position + maxWords);
    const text = slice.map(t => t.word).join(' ');
    const start = slice[0].start;

    chunks.push({ text, start });

    // Advance by (maxWords - overlapWords) to create the sliding window
    const step = Math.max(1, maxWords - overlapWords);
    position += step;
  }

  return chunks;
}
