/**
 * content/page-bridge.js
 *
 * Runs in the PAGE's JavaScript context (injected via <script src=...>).
 * Reads caption track info from ytInitialPlayerResponse or InnerTube (ytcfg),
 * then sends { baseUrl, languageCode } back to the content script via CustomEvent.
 *
 * The actual transcript fetch is done by the extension background service worker
 * (which is NOT intercepted by YouTube's own service worker).
 */
(function () {
  var src = document.currentScript && document.currentScript.src;
  if (!src) return;

  var url = new URL(src);
  var vid   = url.searchParams.get('v');
  var reply = url.searchParams.get('e');
  if (!vid || !reply) return;

  function send(detail) {
    window.dispatchEvent(new CustomEvent(reply, { detail: detail }));
  }

  async function getTracks() {
    // 1. ytInitialPlayerResponse (available on hard page load in page context)
    try {
      var pr = window.ytInitialPlayerResponse;
      if (pr && pr.videoDetails && pr.videoDetails.videoId === vid) {
        var t = pr.captions &&
                pr.captions.playerCaptionsTracklistRenderer &&
                pr.captions.playerCaptionsTracklistRenderer.captionTracks;
        if (t && t.length) {
          console.log('[YTSearch][page] tracks from ytInitialPlayerResponse:', t.length);
          return t;
        }
      }
    } catch (e) {}

    // 2. InnerTube using page's own ytcfg credentials
    try {
      var key = (typeof ytcfg !== 'undefined' && ytcfg.get('INNERTUBE_API_KEY'))
                || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
      var ctx = (typeof ytcfg !== 'undefined' && ytcfg.get('INNERTUBE_CONTEXT'))
                || { client: { clientName: 'WEB', clientVersion: '2.20240726.00.00', hl: 'en', gl: 'US' } };

      var res = await fetch('/youtubei/v1/player?key=' + encodeURIComponent(key) + '&prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: vid, context: ctx, contentCheckOk: true, racyCheckOk: true }),
      });
      var d = await res.json();
      var t2 = d && d.captions &&
               d.captions.playerCaptionsTracklistRenderer &&
               d.captions.playerCaptionsTracklistRenderer.captionTracks;
      console.log('[YTSearch][page] InnerTube tracks:', t2 ? t2.length : 0);
      if (t2 && t2.length) return t2;
    } catch (e) { console.log('[YTSearch][page] InnerTube error:', e.message); }

    return null;
  }

  (async function () {
    var tracks = await getTracks();
    if (!tracks || !tracks.length) { send(null); return; }

    // Pick best track (prefer English)
    var track = null;
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].languageCode && tracks[i].languageCode.indexOf('en') === 0) {
        track = tracks[i]; break;
      }
    }
    if (!track) track = tracks[0];

    console.log('[YTSearch][page] sending track:', track.languageCode, track.baseUrl && track.baseUrl.slice(0, 80));
    send({ baseUrl: track.baseUrl, languageCode: track.languageCode });
  })();
})();

(function () {
  var src = document.currentScript && document.currentScript.src;
  if (!src) return;

  var url = new URL(src);
  var vid   = url.searchParams.get('v');
  var reply = url.searchParams.get('e');
  if (!vid || !reply) return;

  function send(detail) {
    window.dispatchEvent(new CustomEvent(reply, { detail: detail }));
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function chooseTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].languageCode && tracks[i].languageCode.indexOf('en') === 0) return tracks[i];
    }
    return tracks[0];
  }

  function withFmt(baseUrl, fmt) {
    try {
      var u = new URL(baseUrl);
      u.searchParams.set('fmt', fmt);
      return u.toString();
    } catch (e) { return baseUrl + '&fmt=' + fmt; }
  }

  // ------------------------------------------------------------------
  // Transcript parsers
  // ------------------------------------------------------------------
  function parseJson3(text) {
    try {
      var data = JSON.parse(text);
      var evs = (data && data.events) || [];
      var out = [];
      for (var i = 0; i < evs.length; i++) {
        var ev = evs[i];
        if (!ev.segs) continue;
        var t = ev.segs.map(function (s) { return s.utf8 || ''; }).join('').replace(/\n/g, ' ').trim();
        if (t) out.push({ text: t, start: (ev.tStartMs || 0) / 1000 });
      }
      return out;
    } catch (e) { return []; }
  }

  function parseVtt(text) {
    // Strip WEBVTT header and cue settings, extract timestamp + text lines
    var out = [];
    var blocks = text.split(/\n\n+/);
    var tsRe = /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->/;
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].trim().split('\n');
      var tsLine = -1;
      for (var j = 0; j < lines.length; j++) {
        if (tsRe.test(lines[j])) { tsLine = j; break; }
      }
      if (tsLine === -1) continue;
      var m = tsRe.exec(lines[tsLine]);
      var parts = m[1].split(/[:,.]/);
      var start = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]) + parseInt(parts[3]) / 1000;
      var txt = lines.slice(tsLine + 1).join(' ').replace(/<[^>]+>/g, '').trim();
      if (txt) out.push({ text: txt, start: start });
    }
    return out;
  }

  // Regex-based XML parser — avoids DOMParser which YouTube's TrustedTypes blocks
  function parseXml(text) {
    var out = [];
    var re = /<text[^>]+start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var t = m[2]
        .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/<[^>]+>/g, '').replace(/\n/g, ' ').trim();
      if (t) out.push({ text: t, start: parseFloat(m[1]) });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Fetch transcript given tracks — tries multiple formats
  // ------------------------------------------------------------------
  async function fetchTranscript(tracks) {
    var track = chooseTrack(tracks);
    if (!track) return null;
    var base = track.baseUrl;
    var lang = track.languageCode || 'en';
    console.log('[YTSearch][page] baseUrl (first 150):', base && base.slice(0, 150));

    // Build a clean timedtext URL without session-bound params as a fallback
    var cleanBase = 'https://www.youtube.com/api/timedtext?v=' + encodeURIComponent(vid) + '&lang=' + encodeURIComponent(lang);

    var attempts = [
      { url: withFmt(base, 'json3'), parse: parseJson3, label: 'baseUrl-json3' },
      { url: withFmt(base, 'vtt'),   parse: parseVtt,   label: 'baseUrl-vtt'   },
      { url: withFmt(base, 'xml'),   parse: parseXml,   label: 'baseUrl-xml'   },
      { url: cleanBase + '&fmt=json3', parse: parseJson3, label: 'clean-json3' },
      { url: cleanBase + '&fmt=xml',   parse: parseXml,   label: 'clean-xml'   },
    ];

    for (var i = 0; i < attempts.length; i++) {
      var a = attempts[i];
      try {
        var r = await fetch(a.url, { credentials: 'include', cache: 'no-store' });
        var text = await r.text();
        console.log('[YTSearch][page]', a.label, 'status:', r.status, 'length:', text.length, '| first 80:', text.slice(0, 80));
        if (!text || !text.trim()) continue;
        var events = a.parse(text);
        if (events && events.length) { console.log('[YTSearch][page]', a.label, 'parsed:', events.length, 'entries'); return events; }
      } catch (e) { console.log('[YTSearch][page]', a.label, 'error:', e.message); }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Get caption tracks
  // ------------------------------------------------------------------
  async function getTracks() {
    // 1. ytInitialPlayerResponse (available on hard page load)
    try {
      var pr = window.ytInitialPlayerResponse;
      if (pr && pr.videoDetails && pr.videoDetails.videoId === vid) {
        var t = pr.captions &&
                pr.captions.playerCaptionsTracklistRenderer &&
                pr.captions.playerCaptionsTracklistRenderer.captionTracks;
        if (t && t.length) {
          console.log('[YTSearch][page] tracks from ytInitialPlayerResponse:', t.length);
          return t;
        }
      }
    } catch (e) {}

    // 2. InnerTube using page's own ytcfg credentials
    try {
      var key = (typeof ytcfg !== 'undefined' && ytcfg.get('INNERTUBE_API_KEY'))
                || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
      var ctx = (typeof ytcfg !== 'undefined' && ytcfg.get('INNERTUBE_CONTEXT'))
                || { client: { clientName: 'WEB', clientVersion: '2.20240726.00.00', hl: 'en', gl: 'US' } };

      var res = await fetch('/youtubei/v1/player?key=' + encodeURIComponent(key) + '&prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: vid, context: ctx, contentCheckOk: true, racyCheckOk: true }),
      });
      var d = await res.json();
      var t2 = d && d.captions &&
               d.captions.playerCaptionsTracklistRenderer &&
               d.captions.playerCaptionsTracklistRenderer.captionTracks;
      console.log('[YTSearch][page] InnerTube keys:', Object.keys(d), '| tracks:', t2 ? t2.length : 0);
      if (t2 && t2.length) return t2;
    } catch (e) { console.log('[YTSearch][page] InnerTube error:', e); }

    return null;
  }

  // ------------------------------------------------------------------
  // Main
  // ------------------------------------------------------------------
  (async function () {
    var tracks = await getTracks();
    if (!tracks || !tracks.length) {
      console.log('[YTSearch][page] no tracks found');
      send(null);
      return;
    }
    var events = await fetchTranscript(tracks);
    console.log('[YTSearch][page] final events:', events ? events.length : 0);
    send(events && events.length ? events : null);
  })();
})();
