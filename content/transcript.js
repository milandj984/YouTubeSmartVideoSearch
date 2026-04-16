/**
 * content/transcript.js
 *
 * Extracts a YouTube video's transcript via ytInitialPlayerResponse — the
 * same data object YouTube uses internally. This is significantly more
 * resilient than DOM scraping because it survives YouTube UI redesigns.
 *
 * Flow:
 *   1. Read ytInitialPlayerResponse from window
 *   2. Extract the first available caption track URL
 *   3. Fetch the JSON3-format transcript from that URL
 *   4. Parse and return [{text, start}]
 *
 * Throws:
 *   NoTranscriptError — if the video has no captions at all
 *   Error             — for network / parse failures
 *
 * NOTE: This file is injected as a plain content script (not an ES module).
 * It attaches its public API to window.__ytSearch for use by content.js.
 */

// Initialise shared namespace
window.__ytSearch = window.__ytSearch || {};

class NoTranscriptError extends Error {
  constructor() {
    super('This video does not have captions/subtitles available.');
    this.name = 'NoTranscriptError';
  }
}

/**
 * Returns the list of available caption tracks from ytInitialPlayerResponse.
 * Returns an empty array if none are found.
 *
 * @returns {Array<{baseUrl: string, languageCode: string, name: {simpleText: string}}>}
 */
function getCaptionTracks() {
  try {
    const playerResponse = window.ytInitialPlayerResponse;
    if (!playerResponse) return [];

    const tracks =
      playerResponse?.captions
        ?.playerCaptionsTracklistRenderer
        ?.captionTracks;

    return Array.isArray(tracks) ? tracks : [];
  } catch {
    return [];
  }
}

/**
 * Picks the best caption track URL.
 * Prefers English (en / en-US / en-GB), otherwise falls back to the first track.
 *
 * @param {Array} tracks
 * @returns {string|null}
 */
function selectTrackUrl(tracks) {
  if (tracks.length === 0) return null;

  const english = tracks.find(t =>
    t.languageCode?.startsWith('en')
  );
  const chosen = english ?? tracks[0];

  // Force JSON3 format for structured output
  const url = new URL(chosen.baseUrl);
  url.searchParams.set('fmt', 'json3');
  return url.toString();
}

/**
 * Fetches the transcript JSON from the caption track URL and normalises it
 * into the [{text, start}] format used throughout the extension.
 *
 * YouTube JSON3 format:
 * {
 *   events: [
 *     { tStartMs: 1000, dDurationMs: 2000, segs: [{utf8: "Hello"}, ...] },
 *     ...
 *   ]
 * }
 *
 * @param {string} url
 * @returns {Promise<Array<{text: string, start: number}>>}
 */
async function fetchAndParseTranscript(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch transcript: HTTP ${response.status}`);
  }

  const data = await response.json();
  const events = data?.events ?? [];

  const entries = [];

  for (const event of events) {
    if (!event.segs) continue;

    const text = event.segs
      .map(seg => seg.utf8 ?? '')
      .join('')
      .replace(/\n/g, ' ')
      .trim();

    if (!text) continue;

    entries.push({
      text,
      start: (event.tStartMs ?? 0) / 1000, // convert ms → seconds
    });
  }

  return entries;
}

/**
 * Returns the full transcript for the currently loaded YouTube video.
 *
 * @returns {Promise<Array<{text: string, start: number}>>}
 * @throws {NoTranscriptError}
 */
async function getTranscript() {
  const tracks = getCaptionTracks();

  if (tracks.length === 0) {
    throw new NoTranscriptError();
  }

  const url = selectTrackUrl(tracks);
  if (!url) {
    throw new NoTranscriptError();
  }

  const entries = await fetchAndParseTranscript(url);

  if (entries.length === 0) {
    throw new NoTranscriptError();
  }

  return entries;
}

// Attach to shared namespace so content.js can invoke it
window.__ytSearch.getTranscript = getTranscript;
window.__ytSearch.NoTranscriptError = NoTranscriptError;
