/**
 * content/transcript.js
 *
 * Extracts a YouTube video's transcript. Works in two modes:
 *
 *  1. Fast path — reads ytInitialPlayerResponse from window (only valid if
 *     its videoId matches the current URL, i.e. the page was hard-loaded).
 *
 *  2. Fetch fallback — fetches the YouTube watch page HTML and parses
 *     ytInitialPlayerResponse out of the raw source. This is the reliable
 *     path for SPA navigation, injected content scripts, and any case where
 *     the window global is stale or absent.
 *
 * No user interaction is required — captions don't need to be opened.
 *
 * NOTE: Plain content script (not ES module). Attaches to window.__ytSearch.
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
 * Returns the current YouTube video ID from the page URL.
 * @returns {string|null}
 */
function getCurrentVideoId() {
  return new URLSearchParams(window.location.search).get('v');
}

/**
 * Injects page-bridge.js into the page's JS world via <script src=...> so it
 * can read ytInitialPlayerResponse / ytcfg which are invisible to content
 * scripts. Returns { baseUrl, languageCode } for the best caption track.
 *
 * @param {string} videoId
 * @returns {Promise<{baseUrl:string, languageCode:string}|null>}
 */
function getTrackFromPageContext(videoId) {
  return new Promise((resolve) => {
    const replyEvent = '__ytSearch_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const safeId = String(videoId).replace(/[^A-Za-z0-9_-]/g, '');
    const timer = setTimeout(() => { console.log('[YTSearch] page-bridge timed out'); resolve(null); }, 8000);

    window.addEventListener(replyEvent, (e) => {
      clearTimeout(timer);
      const detail = e.detail;
      resolve(detail && detail.baseUrl ? detail : null);
    }, { once: true });

    const bridgeUrl = new URL(chrome.runtime.getURL('content/page-bridge.js'));
    bridgeUrl.searchParams.set('v', safeId);
    bridgeUrl.searchParams.set('e', replyEvent);

    const script = document.createElement('script');
    script.src = bridgeUrl.href;
    script.onload = () => script.remove();
    document.documentElement.appendChild(script);
  });
}

// ---------------------------------------------------------------------------
// Transcript format parsers (run locally in content script)
// ---------------------------------------------------------------------------

function parseJson3(text) {
  try {
    const data = JSON.parse(text);
    const entries = [];
    for (const ev of (data?.events ?? [])) {
      if (!ev.segs) continue;
      const t = ev.segs.map(s => s.utf8 ?? '').join('').replace(/\n/g, ' ').trim();
      if (t) entries.push({ text: t, start: (ev.tStartMs ?? 0) / 1000 });
    }
    return entries;
  } catch { return []; }
}

function parseVtt(text) {
  const out = [];
  const tsRe = /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->/;
  for (const block of text.split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    let tsLine = -1;
    for (let i = 0; i < lines.length; i++) { if (tsRe.test(lines[i])) { tsLine = i; break; } }
    if (tsLine === -1) continue;
    const m = tsRe.exec(lines[tsLine]);
    const p = m[1].split(/[:,.]/);
    const start = +p[0] * 3600 + +p[1] * 60 + +p[2] + +p[3] / 1000;
    const t = lines.slice(tsLine + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (t) out.push({ text: t, start });
  }
  return out;
}

function parseXml(text) {
  const out = [];
  const re = /<text[^>]+start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = m[2]
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/<[^>]+>/g, '').replace(/\n/g, ' ').trim();
    if (t) out.push({ text: t, start: parseFloat(m[1]) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetch via background service worker (bypasses YouTube's own service worker)
// ---------------------------------------------------------------------------

async function fetchViaBackground(url) {
  const response = await chrome.runtime.sendMessage({ type: 'FETCH_URL', url });
  if (response?.error) throw new Error(response.error);
  return response?.text ?? '';
}

function withFmt(baseUrl, fmt) {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set('fmt', fmt);
    return u.toString();
  } catch { return baseUrl + '&fmt=' + fmt; }
}

/**
 * Returns the full transcript for the currently loaded YouTube video.
 *
 * Strategy:
 *  1. Page bridge (injected script) reads ytInitialPlayerResponse/ytcfg from
 *     the page's own JS world to get the caption track URL.
 *  2. Background service worker fetches the caption URL — it is NOT intercepted
 *     by YouTube's own service worker, unlike fetches from the page context.
 *  3. Tries json3 → vtt → xml formats in sequence.
 *
 * @returns {Promise<Array<{text: string, start: number}>>}
 * @throws {NoTranscriptError}
 */
async function getTranscript() {
  const videoId = getCurrentVideoId();
  console.log('[YTSearch] videoId:', videoId);
  if (!videoId) throw new NoTranscriptError();

  const track = await getTrackFromPageContext(videoId);
  console.log('[YTSearch] track from page bridge:', track ? track.languageCode : 'null');
  if (!track) throw new NoTranscriptError();

  const formats = [
    { url: withFmt(track.baseUrl, 'json3'), parse: parseJson3, label: 'json3' },
    { url: withFmt(track.baseUrl, 'vtt'),   parse: parseVtt,   label: 'vtt'   },
    { url: withFmt(track.baseUrl, 'xml'),   parse: parseXml,   label: 'xml'   },
  ];

  for (const { url, parse, label } of formats) {
    try {
      const text = await fetchViaBackground(url);
      console.log('[YTSearch] bg fetch', label, 'length:', text.length);
      if (!text.trim()) continue;
      const entries = parse(text);
      if (entries.length > 0) {
        console.log('[YTSearch] parsed', entries.length, 'entries via', label);
        return entries;
      }
    } catch (e) {
      console.log('[YTSearch]', label, 'failed:', e.message);
    }
  }

  throw new NoTranscriptError();
}

// Attach to shared namespace so content.js can invoke it
window.__ytSearch.getTranscript = getTranscript;
window.__ytSearch.NoTranscriptError = NoTranscriptError;
