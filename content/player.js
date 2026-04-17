/**
 * content/player.js
 *
 * Controls the YouTube video player from within the content script context.
 * Uses direct DOM access to the <video> element — the most reliable approach
 * regardless of YouTube's player API changes.
 *
 * NOTE: Plain content script (not ES module). Attaches to window.__ytSearch.
 */

window.__ytSearch = window.__ytSearch || {};

/**
 * Seeks the currently playing YouTube video to the given timestamp.
 * Also ensures the video is playing after the seek.
 *
 * @param {number} seconds  Target time in seconds (may be a float)
 * @returns {boolean}  true if seek was successful, false if no video found
 */
function seekTo(seconds) {
  const video = findVideoElement();
  if (!video) {
    console.warn('[YT Smart Search] Could not find video element to seek.');
    return false;
  }

  video.currentTime = seconds;

  // Resume playback if paused (user may have paused before clicking a result)
  if (video.paused) {
    video.play().catch(() => {
      // Autoplay may be blocked by the browser — not critical
    });
  }

  return true;
}

/**
 * Finds the primary YouTube <video> element on the page.
 * Tries the movie_player container first, then falls back to any <video>.
 *
 * @returns {HTMLVideoElement|null}
 */
function findVideoElement() {
  // Preferred: the video inside the YouTube movie_player container
  const playerVideo = document.querySelector('#movie_player video');
  if (playerVideo) return playerVideo;

  // Fallback: any visible <video> element with a non-zero duration
  const allVideos = Array.from(document.querySelectorAll('video'));
  return allVideos.find(v => v.duration > 0) ?? null;
}

/**
 * Toggles play/pause on the YouTube video.
 * @returns {'playing'|'paused'|'not-found'}
 */
function togglePlayback() {
  const video = findVideoElement();
  if (!video) return 'not-found';
  if (video.paused) {
    video.play().catch(() => {});
    return 'playing';
  } else {
    video.pause();
    return 'paused';
  }
}

// Attach to shared namespace so content.js can invoke it
window.__ytSearch.seekTo = seekTo;
window.__ytSearch.togglePlayback = togglePlayback;
