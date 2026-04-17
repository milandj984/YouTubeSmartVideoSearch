/**
 * popup/popup.js
 *
 * State machine for the extension popup.
 *
 * States:
 *  idle          — Not on YouTube or no video in URL
 *  ready         — YouTube video detected, not yet scanned
 *  scanning      — Scan pipeline running (transcript → embed → save)
 *  searchable    — Video is cached; search input is active
 *  no-transcript — Video has no captions
 *  error         — Unexpected failure
 */

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

const STATES = ['idle', 'ready', 'scanning', 'no-transcript', 'error', 'searchable'];

function setState(name) {
  for (const id of STATES) {
    const el = document.getElementById(`state-${id}`);
    if (el) el.hidden = (id !== name);
  }
}

// ---------------------------------------------------------------------------
// Session context
// ---------------------------------------------------------------------------

let currentTabId = null;
let currentVideoId = null;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Extracts the YouTube video ID from a URL string.
 * Returns null if the URL is not a YouTube watch page.
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('youtube.com')) return null;
    return u.searchParams.get('v') ?? null;
  } catch {
    return null;
  }
}

/**
 * Formats a time in seconds to MM:SS or HH:MM:SS.
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Simple debounce.
 *
 * @param {Function} fn
 * @param {number} delay  ms
 * @returns {Function}
 */
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ---------------------------------------------------------------------------
// Progress bar helpers
// ---------------------------------------------------------------------------

const progressFill = document.getElementById('progress-fill');
const scanningStatus = document.getElementById('scanning-status');
const scanningDetail = document.getElementById('scanning-detail');

function setProgress({ message = '', detail = '', percent = null }) {
  if (scanningStatus) scanningStatus.textContent = message;
  if (scanningDetail) scanningDetail.textContent = detail;

  if (progressFill) {
    if (percent === null) {
      progressFill.classList.add('progress-bar__fill--indeterminate');
      progressFill.style.width = '';
    } else {
      progressFill.classList.remove('progress-bar__fill--indeterminate');
      progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    }
  }
}

// ---------------------------------------------------------------------------
// Results rendering
// ---------------------------------------------------------------------------

const resultsContainer = document.getElementById('results-container');
const searchHint = document.getElementById('search-hint');

function renderResults(results) {
  resultsContainer.innerHTML = '';

  if (results.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'no-results';
    empty.textContent = 'No matching segments found. Try rephrasing your query.';
    resultsContainer.appendChild(empty);
    return;
  }

  searchHint.hidden = true;

  for (const result of results) {
    const card = document.createElement('button');
    card.className = 'result-card';
    card.setAttribute('aria-label', `Jump to ${formatTime(result.start)}: ${result.text}`);

    const timestamp = document.createElement('span');
    timestamp.className = 'result-card__timestamp';
    timestamp.textContent = formatTime(result.start);

    const text = document.createElement('span');
    text.className = 'result-card__text';
    text.textContent = result.text;

    const score = document.createElement('span');
    score.className = 'result-card__score';
    score.textContent = `${Math.round(result.score * 100)}%`;

    card.appendChild(timestamp);
    card.appendChild(text);
    card.appendChild(score);

    card.addEventListener('click', () => seekTo(result.start));
    resultsContainer.appendChild(card);
  }
}

function showSearchLoading() {
  resultsContainer.innerHTML = `
    <div class="results--loading">
      <div class="spinner"></div>
      Searching…
    </div>`;
}

// ---------------------------------------------------------------------------
// Message helpers (communicate with background service worker)
// ---------------------------------------------------------------------------

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function startScan() {
  if (!currentTabId || !currentVideoId) return;

  setState('scanning');
  setProgress({ message: 'Starting scan…', percent: null });

  const response = await sendMessage({
    type: 'SCAN_VIDEO',
    videoId: currentVideoId,
    tabId: currentTabId,
    title: document.title,
  });

  if (!response) {
    setState('error');
    document.getElementById('error-message').textContent =
      'No response from background. Try reloading the extension.';
    return;
  }

  if (response.type === 'SCAN_ERROR') {
    if (response.noTranscript) {
      setState('no-transcript');
      const diag = document.getElementById('no-transcript-diag');
      if (diag) diag.textContent = response.message ?? '';
    } else {
      setState('error');
      document.getElementById('error-message').textContent = response.message ?? 'Unknown error';
    }
    return;
  }

  // SCAN_COMPLETE
  transitionToSearchable();
}

async function seekTo(time) {
  await sendMessage({ type: 'SEEK', tabId: currentTabId, time });
  // Seeking always resumes playback — reflect that in the pause button
  setPauseButtonState('playing');
}

async function performSearch(query) {
  if (!query.trim() || !currentVideoId) return;

  showSearchLoading();

  const response = await sendMessage({
    type: 'SEARCH',
    videoId: currentVideoId,
    query: query.trim(),
  });

  if (response?.type === 'SEARCH_RESULT') {
    renderResults(response.results);
  } else {
    const errEl = document.createElement('p');
    errEl.className = 'no-results';
    errEl.textContent = `Search failed: ${response?.message ?? 'unknown error'}`;
    resultsContainer.replaceChildren(errEl);
  }
}

function transitionToSearchable() {
  setState('searchable');
  searchHint.hidden = false;
  resultsContainer.innerHTML = '';
  const input = document.getElementById('search-input');
  if (input) {
    input.value = '';
    input.focus();
  }
}

async function rescanVideo() {
  // Delete cached data first, then re-scan
  await sendMessage({ type: 'DELETE_VIDEO', videoId: currentVideoId });
  await startScan();
}

// ---------------------------------------------------------------------------
// Progress listener (relay from service worker during scan)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'SCAN_PROGRESS') return;

  const { stage, done, total, message: msg } = message;

  if (stage === 'embedding' && total > 0) {
    const percent = Math.round((done / total) * 100);
    setProgress({
      message: 'Embedding chunks…',
      detail: `${done} / ${total} chunks processed`,
      percent,
    });
  } else if (stage === 'transcript') {
    setProgress({ message: msg ?? 'Fetching transcript…', percent: null });
  } else if (stage === 'chunking') {
    setProgress({ message: msg ?? 'Chunking transcript…', percent: 20 });
  } else if (stage === 'saving') {
    setProgress({ message: 'Saving to cache…', percent: 98 });
  }
});

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

async function init() {
  // Get the current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    setState('idle');
    return;
  }

  currentTabId = tab.id;
  currentVideoId = extractVideoId(tab.url ?? '');

  if (!currentVideoId) {
    setState('idle');
    return;
  }

  // Show the video ID in the ready state
  const readyIdEl = document.getElementById('ready-video-id');
  if (readyIdEl) readyIdEl.textContent = currentVideoId;

  // Check if this video is already cached
  const { exists } = await sendMessage({ type: 'VIDEO_EXISTS', videoId: currentVideoId });

  if (exists) {
    transitionToSearchable();
  } else {
    setState('ready');
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

document.getElementById('btn-scan')?.addEventListener('click', startScan);
document.getElementById('btn-retry')?.addEventListener('click', startScan);
document.getElementById('btn-rescan')?.addEventListener('click', rescanVideo);

const btnPause = document.getElementById('btn-pause');

function setPauseButtonState(state) {
  const isPlaying = state === 'playing';
  document.getElementById('icon-pause').style.display = isPlaying ? '' : 'none';
  document.getElementById('icon-play').style.display = isPlaying ? 'none' : '';
  document.getElementById('btn-pause-label').textContent = isPlaying ? 'Pause' : 'Play';
  btnPause?.setAttribute('aria-pressed', String(!isPlaying));
}

btnPause?.addEventListener('click', async () => {
  const response = await sendMessage({ type: 'TOGGLE_PLAYBACK', tabId: currentTabId });
  setPauseButtonState(response?.state ?? 'playing');
});

const searchInput = document.getElementById('search-input');
const debouncedSearch = debounce(performSearch, 400);

searchInput?.addEventListener('input', (e) => {
  const query = e.target.value;
  if (!query.trim()) {
    resultsContainer.innerHTML = '';
    searchHint.hidden = false;
    return;
  }
  debouncedSearch(query);
});

// Run on popup open
init();
