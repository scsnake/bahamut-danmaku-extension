// bookmarks/common.js
//
// Helpers shared by every context that touches scene bookmarks: the content
// script, the background service worker (via importScripts) and the manager
// page. Loaded as a classic script everywhere, so it exposes one global.
// displayTitle() needs i18n.js, which the content scripts and the manager
// load; the background never calls it.
//
// Storage layout (chrome.storage.local):
//   bookmarks        → array of bookmark metadata (small; safe to read often)
//   bmthumb:<id>     → JPEG data URL of that bookmark's thumbnail
// Writes go through the background (see store.js); reads may happen anywhere.

const DmkBookmarks = (() => {
  const VIDEO_URL = 'https://ani.gamer.com.tw/animeVideo.php';
  const THUMB_PREFIX = 'bmthumb:';
  // Deep links carry the position in the hash (#dmk=83.4 or #dmk=83.4-95) so
  // Bahamut's server never sees an unknown query parameter.
  const HASH_KEY = 'dmk';
  const HASH_RE = new RegExp(`(?:^#|&)${HASH_KEY}=(\\d+(?:\\.\\d+)?)(?:-(\\d+(?:\\.\\d+)?))?`);

  const round1 = (n) => Math.round(n * 10) / 10;

  // 83.4 → "1:23" (or "1:23.4" with tenths), 3723 → "1:02:03".
  function formatTime(sec, { tenths = false } = {}) {
    const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
    const whole = Math.floor(safe);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const frac = tenths ? `.${Math.floor((safe - whole) * 10 + 1e-6)}` : '';
    const ss = String(whole % 60).padStart(2, '0') + frac;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  // Like formatTime, but keeps tenths when present so it round-trips through
  // parseTime without losing precision (used by editable time fields).
  function formatExact(sec) {
    return formatTime(sec, { tenths: round1(sec) % 1 !== 0 });
  }

  // Accepts "1:02:03", "12:34", "95" or "95.5"; returns seconds or NaN.
  function parseTime(str) {
    const parts = String(str).trim().split(':');
    if (parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return NaN;
    return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  }

  function isClip(b) {
    return b.end != null && b.end > b.start;
  }

  function formatRange(b) {
    return isClip(b) ? `${formatTime(b.start)}–${formatTime(b.end)}` : formatTime(b.start);
  }

  function displayTitle(b) {
    return b.title || DmkI18n.t(isClip(b) ? 'bm.untitledClip' : 'bm.untitledMoment');
  }

  function deepLink(b) {
    const pos = isClip(b) ? `${round1(b.start)}-${round1(b.end)}` : `${round1(b.start)}`;
    return `${VIDEO_URL}?sn=${encodeURIComponent(b.videoSn)}#${HASH_KEY}=${pos}`;
  }

  function parseDeepLinkHash(hash) {
    const m = HASH_RE.exec(hash || '');
    if (!m) return null;
    const start = Number(m[1]);
    const end = m[2] != null ? Number(m[2]) : null;
    return { start, end: end != null && end > start ? end : null };
  }

  function newId() {
    return `bm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  // Promise wrapper for runtime messages handled in store.js. Rejects on
  // transport errors and on handler-reported failures.
  function send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res || !res.success) return reject(new Error((res && res.error) || 'Unknown error'));
        resolve(res);
      });
    });
  }

  async function loadAll() {
    const { bookmarks = [] } = await chrome.storage.local.get('bookmarks');
    return bookmarks;
  }

  // Deletes a bookmark and resolves to a function that restores it, thumbnail
  // included — backs the "Undo" buttons.
  async function removeWithUndo(b) {
    const key = THUMB_PREFIX + b.id;
    const { [key]: thumb } = await chrome.storage.local.get(key);
    await send('BOOKMARK_DELETE', { ids: [b.id] });
    return () => send('BOOKMARK_IMPORT', { bookmarks: [b], thumbs: thumb ? { [b.id]: thumb } : {} });
  }

  return {
    THUMB_PREFIX,
    round1,
    formatTime,
    formatExact,
    parseTime,
    isClip,
    formatRange,
    displayTitle,
    deepLink,
    parseDeepLinkHash,
    newId,
    send,
    loadAll,
    removeWithUndo,
  };
})();
