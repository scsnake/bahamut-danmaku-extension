// content.js

const LOG = '[Danmaku Enhancer]';
const DANMU_API = 'https://api.gamer.com.tw/anime/v1/danmu.php';

// Renderer constants, matched to the official danmaku manager in
// anime_player.js (see ROADMAP.md).
const TIME_UNIT_MS = 200;          // official fires comments in 200 ms buckets
const STATIC_DURATION_MS = 5000;   // top / bottom comments
const ROLLING_UNIT_SEC = 12;       // speed = (screen width + 2 * text width) / 12 s
const FONT_SIZES = { 0: 16, 1: 24, 2: 28 };
const MODES = { 0: 'rolling', 1: 'top', 2: 'bottom' };
// Comments still waiting for the AI this long after their time are dropped.
const GRACE_TENTHS = 30;
const AI_LOOKAHEAD_TENTHS = 20;
const SETTINGS_POLL_MS = 1000;
const REFETCH_DEBOUNCE_MS = 300;
const DEBUG_FLUSH_MS = 2000;
const STATS_INTERVAL_MS = 10000;
// How far back to look for comments still crossing the screen after a seek
// or start (a rolling comment takes at most about 12 s in fullscreen).
const BACKFILL_MS = 12000;

let currentVideoSn = null;
let bookmarks = null;
let videoElement = null;
let playerElement = null;
let overlayElement = null;
let danmakuData = [];      // sorted by time; `time` is in tenths of a second
let bySn = new Map();
let settings = {};
let officialKeywords = [];
let display = readOfficialDisplay();

let nextIndex = 0;         // first item in danmakuData not yet due
let lastTenths = 0;        // items up to this time were already taken
let dueQueue = [];         // due items still waiting (AI) to be rendered
let lastBucket = null;
let rafId = 0;
let adActive = false;
let areaWidth = 0;
let areaHeight = 0;
// performance.now() of our own danmu.php requests, to tell them apart from
// the official player's.
const ownFetchStarts = [];

// All in-flight danmaku animations. Paused/resumed with the video,
// cancelled on seek.
const activeAnimations = new Set();

// Debug log. Entries go to background.js, which keeps the newest ones in
// chrome.storage.local; the popup exports them as a JSON file.
const debugBuffer = [];
const stats = newStats();

function newStats() {
  return { rendered: 0, backfilled: 0, droppedLate: 0, blocked: 0, aiRequested: 0, aiBlocked: 0, aiFailed: 0 };
}

function dlog(event, data) {
  console.log(LOG, event, data === undefined ? '' : data);
  debugBuffer.push({
    t: new Date().toISOString(),
    src: 'content',
    sn: currentVideoSn,
    vt: videoElement ? Math.round(videoElement.currentTime * 10) / 10 : null,
    event,
    data,
  });
}

function flushDebugLog() {
  if (!debugBuffer.length) return;
  const entries = debugBuffer.splice(0);
  chrome.runtime.sendMessage({ type: 'DEBUG_LOG', entries }).catch(() => {});
}

function logStats() {
  if (!videoElement || videoElement.paused) return;
  dlog('stats', {
    ...stats,
    onScreen: activeAnimations.size,
    waiting: dueQueue.length,
    nextIndex,
    total: danmakuData.length,
  });
  Object.assign(stats, newStats());
}

function overlayOn() {
  return settings.overlayEnabled !== false;
}

// Pixel-based vertical placement per mode, like the official allocator:
// take the first free position, else the one with the least overlap.
class LaneAllocator {
  constructor() {
    this.reset(0);
  }

  reset(height) {
    this.height = Math.max(0, Math.floor(height));
    // busyUntil[y] = video time (ms) until pixel line y is taken.
    this.busyUntil = new Float64Array(this.height);
  }

  allocate(h, startMs, endMs) {
    h = Math.ceil(h);
    let best = 0;
    let bestScore = Infinity;
    let y = 0;
    while (y + h <= this.height) {
      let score = 0;
      let lastBusy = -1;
      for (let i = y; i < y + h; i++) {
        if (this.busyUntil[i] > startMs) {
          score += this.busyUntil[i] - startMs;
          lastBusy = i;
        }
      }
      if (lastBusy < 0) {
        best = y;
        bestScore = 0;
        break;
      }
      if (score < bestScore) {
        bestScore = score;
        best = y;
      }
      y = lastBusy + 1;
    }
    for (let i = best; i < Math.min(best + h, this.height); i++) {
      this.busyUntil[i] = Math.max(this.busyUntil[i], endMs);
    }
    return best;
  }
}

const lanes = {
  rolling: new LaneAllocator(),
  top: new LaneAllocator(),
  bottom: new LaneAllocator(),
};

async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  const videoSn = urlParams.get('sn');
  if (!videoSn) return;
  currentVideoSn = videoSn;
  setInterval(flushDebugLog, DEBUG_FLUSH_MS);
  setInterval(logStats, STATS_INTERVAL_MS);
  dlog('init', { url: location.pathname + location.search, version: chrome.runtime.getManifest().version });

  const storage = await chrome.storage.local.get("settings");
  settings = storage.settings || {
    aiFilterEnabled: true,
    aiStrictness: 'moderate',
    keywordBlocklist: [],
    userBlocklist: []
  };

  let danmuLayer;
  try {
    videoElement = await waitForElement('#ani_video_html5_api');
    // The official layer. Our overlay goes inside it so both always cover
    // the same area (normal, theater and fullscreen).
    danmuLayer = await waitForElement('#ani_video .vjs-danmu');
  } catch (err) {
    dlog('error', { where: 'init', message: err.message });
    return;
  }
  const videoContainer = document.querySelector('#ani_video');
  playerElement = videoContainer;

  overlayElement = document.createElement('div');
  overlayElement.id = 'custom_danmu_overlay';
  danmuLayer.appendChild(overlayElement);
  new ResizeObserver(onResize).observe(overlayElement);
  onResize();
  addPlayerToggle();
  applyOverlayMode();
  dlog('player', {
    area: [areaWidth, areaHeight],
    video: [videoElement.clientWidth, videoElement.clientHeight],
    screenWidth: window.screen.availWidth,
    display,
    settings: { overlayEnabled: overlayOn(), aiFilterEnabled: settings.aiFilterEnabled },
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const prev = settings;
    settings = changes.settings.newValue || {};
    dlog('settings', { overlayEnabled: overlayOn(), aiFilterEnabled: settings.aiFilterEnabled });
    processDanmaku();
    removeOnScreen(el => bySn.get(Number(el.dataset.sn))?.isBlocked);
    if ((prev.overlayEnabled !== false) !== overlayOn()) applyOverlayMode();
  });

  bookmarks = initBookmarks({
    video: videoElement,
    container: videoContainer,
    getVideoSn: () => currentVideoSn,
    getDanmaku: () => danmakuData,
  });

  watchOfficialKeywords();
  watchOfficialRefetch();
  setInterval(pollOfficialDisplay, SETTINGS_POLL_MS);

  videoElement.addEventListener('seeking', cleanAll);
  videoElement.addEventListener('seeked', resync);
  videoElement.addEventListener('loadedmetadata', resync); // ad -> episode
  videoElement.addEventListener('pause', pause);
  videoElement.addEventListener('waiting', pause);
  videoElement.addEventListener('play', resume);
  videoElement.addEventListener('playing', resume);
  videoElement.addEventListener('ratechange', () => {
    dlog('ratechange', { rate: videoElement.playbackRate });
    activeAnimations.forEach(a => { a.playbackRate = videoElement.playbackRate || 1; });
  });
  videoElement.addEventListener('seeked', () => dlog('seeked'));
  videoElement.addEventListener('loadedmetadata', () => dlog('loadedmetadata', { duration: videoElement.duration }));
  window.addEventListener('pagehide', flushDebugLog);

  await loadDanmaku();
}

// Our layer or the official one (popup switch or control-bar button). The
// official player keeps running underneath; the `dmk-active` class only
// hides its comments.
function applyOverlayMode() {
  const on = overlayOn();
  playerElement.classList.toggle('dmk-active', on);
  updatePlayerToggle();
  dlog('overlayMode', { on });
  if (on) resync();
  else cleanAll();
}

let playerToggle = null;

// A button next to the official danmaku button in the control bar.
function addPlayerToggle() {
  const officialButton = playerElement.querySelector('#danmuToggle');
  if (!officialButton) {
    dlog('error', { where: 'addPlayerToggle', message: '#danmuToggle not found' });
    return;
  }
  playerToggle = document.createElement('button');
  playerToggle.type = 'button';
  playerToggle.className = 'vjs-control dmk-layer-toggle';
  playerToggle.addEventListener('click', async (e) => {
    e.stopPropagation();
    // storage.onChanged applies the change, in this tab and in others.
    await chrome.storage.local.set({ settings: { ...settings, overlayEnabled: !overlayOn() } });
  });
  officialButton.after(playerToggle);
  updatePlayerToggle();
}

function updatePlayerToggle() {
  if (!playerToggle) return;
  const on = overlayOn();
  playerToggle.textContent = on ? '增強' : '官方';
  playerToggle.classList.toggle('is-on', on);
  playerToggle.title = on
    ? 'Enhanced danmaku layer (click for the official one)'
    : 'Official danmaku (click for the enhanced layer)';
}

// Loads (or reloads) the list. On a reload, keeps what is on screen and the
// AI results, drops comments the server no longer returns (for example from
// a user just muted), and continues from the current position.
async function loadDanmaku() {
  let list;
  const sn = currentVideoSn;
  const started = performance.now();
  try {
    list = await fetchDanmaku(sn, display.geos);
  } catch (err) {
    dlog('error', { where: 'fetchDanmaku', message: err.message });
    return;
  }
  // The episode changed while this request was in flight.
  if (sn !== currentVideoSn) return;
  const previous = bySn;
  list.forEach(d => {
    const prev = previous.get(d.sn);
    if (prev) {
      d.aiEvaluated = prev.aiEvaluated === true;
      d.aiBlocked = prev.aiBlocked;
    }
  });
  danmakuData = list;
  bySn = new Map(list.map(d => [d.sn, d]));
  processDanmaku();
  dlog('loaded', {
    count: danmakuData.length,
    reload: previous.size > 0,
    removed: previous.size ? [...previous.keys()].filter(sn => !bySn.has(sn)).length : 0,
    blocked: danmakuData.filter(d => d.isBlocked).length,
    ms: Math.round(performance.now() - started),
  });

  if (!previous.size) {
    resync();
    return;
  }
  nextIndex = indexAfter(danmakuData, lastTenths);
  dueQueue = dueQueue.map(d => bySn.get(d.sn)).filter(Boolean);
  removeOnScreen(el => {
    const d = bySn.get(Number(el.dataset.sn));
    return !d || d.isBlocked;
  });
}

async function fetchDanmaku(videoSn, geos) {
  // Same request as the official player. An empty geo list means the user
  // turned off every danmaku source. The server applies the user's official
  // keyword filters and mute list, so the request carries the cookies.
  if (!geos.length) return [];
  const url = `${DANMU_API}?videoSn=${encodeURIComponent(videoSn)}&geo=${encodeURIComponent(geos.join(','))}`;
  ownFetchStarts.push(performance.now());
  if (ownFetchStarts.length > 10) ownFetchStarts.shift();
  const res = await fetch(url, { credentials: 'include' });
  const json = await res.json();
  const list = (json && json.data && json.data.danmu) || [];
  list.sort((a, b) => a.time - b.time || a.sn - b.sn);
  return list;
}

// The official player fetches danmu.php again after a mute, a keyword
// change, a source change or a click on its refresh button. Follow it.
// It also fetches it when it moves to another episode in place (next
// episode, episode list, autoplay): it calls history.pushState('?sn=…')
// without a page load, so the request's videoSn tells us the new episode.
function watchOfficialRefetch() {
  let timer = 0;
  new PerformanceObserver(entries => {
    for (const entry of entries.getEntries()) {
      if (!entry.name.includes('/anime/v1/danmu.php')) continue;
      const own = ownFetchStarts.findIndex(t => Math.abs(t - entry.startTime) < 50);
      if (own >= 0) {
        ownFetchStarts.splice(own, 1);
        continue;
      }
      let sn = null;
      try { sn = new URL(entry.name).searchParams.get('videoSn'); } catch (_) {}
      dlog('officialRefetch', { videoSn: sn, ownPending: ownFetchStarts.length });
      if (sn && sn !== currentVideoSn) changeEpisode(sn);
      clearTimeout(timer);
      timer = setTimeout(loadDanmaku, REFETCH_DEBOUNCE_MS);
    }
  }).observe({ type: 'resource' });
}

// Drops the old episode's list; the caller loads the new one.
function changeEpisode(sn) {
  dlog('episodeChange', { from: currentVideoSn, to: sn, url: location.search });
  currentVideoSn = sn;
  cleanAll();
  danmakuData = [];
  bySn = new Map();
  nextIndex = 0;
  lastTenths = 0;
  lastBucket = null;
  if (bookmarks) bookmarks.episodeChanged();
}

// --- Official settings -----------------------------------------------------

// Reads the settings the official player stores in localStorage.
function readOfficialDisplay() {
  const get = (key) => {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  };
  const opacity = (get('ANIME_danmu_opacity') || '0.7,1,1,1').split(',');
  let geos = ['TW', 'HK'];
  try {
    const parsed = JSON.parse(get('ANIME_DANMU_GEOS'));
    if (Array.isArray(parsed)) geos = parsed;
  } catch (_) {}
  const sizeRate = parseFloat(get('ANIME_danmu_size'));
  return {
    enabled: get('ANIME_danmu') !== 'off',
    opacity: clamp(parseFloat(opacity[0]), 0, 1, 0.7),
    modeAllow: {
      rolling: opacity[1] !== '0',
      top: opacity[2] !== '0',
      bottom: opacity[3] !== '0',
    },
    sizeRate: clamp(sizeRate, 0.5, 1.5, 1),
    geos,
  };
}

function pollOfficialDisplay() {
  const next = readOfficialDisplay();
  if (JSON.stringify(next) === JSON.stringify(display)) return;
  const prev = display;
  display = next;
  dlog('officialDisplay', display);

  if (display.geos.join() !== prev.geos.join()) {
    loadDanmaku();
    return;
  }
  if (!display.enabled) {
    cleanAll();
    return;
  }
  if (display.opacity !== prev.opacity) {
    overlayElement.querySelectorAll('.custom-danmaku-item').forEach(el => {
      el.style.opacity = display.opacity;
    });
  }
  // Remove on-screen comments of a mode that was just turned off.
  for (const mode of Object.keys(display.modeAllow)) {
    if (!display.modeAllow[mode]) {
      removeOnScreen(el => el.dataset.mode === mode);
    }
  }
}

// The official keyword list is server-rendered into the settings panel and
// edited in place, so read it from the DOM and follow its changes.
async function watchOfficialKeywords() {
  let body;
  try {
    body = await waitForElement('.ani-keyword-body');
  } catch (_) {
    return; // Not logged in, or the panel is missing.
  }
  const read = () => {
    officialKeywords = [...body.querySelectorAll('.ani-keyword-label > span')]
      .map(s => s.textContent.trim())
      .filter(Boolean);
    dlog('officialKeywords', { count: officialKeywords.length });
  };
  read();
  new MutationObserver(() => {
    read();
    processDanmaku();
    removeOnScreen(el => {
      const d = bySn.get(Number(el.dataset.sn));
      return d && d.isBlocked;
    });
  }).observe(body, { childList: true, subtree: true });
}

// --- Filtering ---------------------------------------------------------------

function passesBasicFilter(danmaku) {
  const text = danmaku.text || '';
  const userid = danmaku.userid;

  if (settings.userBlocklist && settings.userBlocklist.includes(userid)) return false;

  const allKeywords = [...(settings.keywordBlocklist || []), ...officialKeywords];
  for (const kw of allKeywords) {
    if (kw && text.includes(kw)) return false;
  }
  return true;
}

function processDanmaku() {
  danmakuData.forEach(d => {
    d.isBlocked = !passesBasicFilter(d);
    if (d.aiEvaluated === undefined) d.aiEvaluated = false;
    if (d.aiBlocked) d.isBlocked = true;
  });
}

function requestAiEvaluation(nowTenths) {
  const toEvaluate = [];
  for (let i = nextIndex; i < danmakuData.length; i++) {
    const d = danmakuData[i];
    if (d.time > nowTenths + AI_LOOKAHEAD_TENTHS) break;
    if (!d.isBlocked && !d.aiEvaluated) toEvaluate.push(d);
  }
  for (const d of dueQueue) {
    if (!d.isBlocked && !d.aiEvaluated) toEvaluate.push(d);
  }
  if (!toEvaluate.length) return;

  toEvaluate.forEach(d => { d.aiEvaluated = 'pending'; });
  stats.aiRequested += toEvaluate.length;
  const batch = toEvaluate.map(d => ({ sn: d.sn, text: d.text }));
  const started = performance.now();
  chrome.runtime.sendMessage({ type: 'AI_FILTER_BATCH', batch }, (res) => {
    if (chrome.runtime.lastError || !res || !res.success) {
      stats.aiFailed += toEvaluate.length;
      dlog('aiBatchFailed', {
        size: toEvaluate.length,
        error: chrome.runtime.lastError?.message || res?.error || 'no response',
      });
    } else if (performance.now() - started > 1000) {
      dlog('aiBatchSlow', { size: toEvaluate.length, ms: Math.round(performance.now() - started) });
    }
    if (res && res.success) {
      const evaluated = new Map(toEvaluate.map(d => [d.sn, d]));
      res.results.forEach(r => {
        const d = evaluated.get(r.sn);
        if (d && d.aiEvaluated === 'pending') {
          d.aiEvaluated = true;
          if (!r.allowed) {
            d.aiBlocked = true;
            d.isBlocked = true;
            stats.aiBlocked++;
          }
        }
      });
    } else {
      // AI failed; unblock so items still render.
      toEvaluate.forEach(d => {
        if (d.aiEvaluated === 'pending') d.aiEvaluated = true;
      });
    }
  });
}

// --- Playback loop -----------------------------------------------------------

function tick() {
  rafId = requestAnimationFrame(tick);
  const nowMs = videoElement.currentTime * 1000;
  const bucket = Math.floor(nowMs / TIME_UNIT_MS) * TIME_UNIT_MS;
  if (bucket === lastBucket) return;
  lastBucket = bucket;
  try {
    step(nowMs, bucket);
  } catch (err) {
    dlog('error', { where: 'tick', message: err.message, stack: String(err.stack).slice(0, 500) });
  }
}

function step(nowMs, bucket) {
  // Pre-roll ads play in the same <video>; show nothing until the episode.
  if (playerElement.classList.contains('vjs-ad-playing')) {
    if (!adActive) {
      adActive = true;
      dlog('adStart');
      cleanAll();
    }
    return;
  }
  if (adActive) {
    adActive = false;
    dlog('adEnd');
    resync();
    return;
  }
  if (!overlayOn() || !display.enabled || !danmakuData.length) return;

  const nowTenths = bucket / 100;
  if (settings.aiFilterEnabled) requestAiEvaluation(nowTenths);

  while (nextIndex < danmakuData.length && danmakuData[nextIndex].time <= nowTenths) {
    dueQueue.push(danmakuData[nextIndex]);
    nextIndex++;
  }
  lastTenths = nowTenths;

  dueQueue = dueQueue.filter(d => {
    if (d.isBlocked) {
      stats.blocked++;
      return false;
    }
    // Missed the window (probably AI never came back). Drop silently.
    if (nowTenths - d.time > GRACE_TENTHS) {
      stats.droppedLate++;
      return false;
    }
    if (settings.aiFilterEnabled && d.aiEvaluated !== true) return true;
    if (renderDanmaku(d, nowMs)) stats.rendered++;
    return false;
  });
}

function pause() {
  cancelAnimationFrame(rafId);
  rafId = 0;
  activeAnimations.forEach(a => { try { a.pause(); } catch (_) {} });
}

function resume() {
  if (videoElement.paused || videoElement.seeking) return;
  activeAnimations.forEach(a => { try { a.play(); } catch (_) {} });
  if (!rafId) rafId = requestAnimationFrame(tick);
}

function cleanAll() {
  activeAnimations.forEach(a => { try { a.cancel(); } catch (_) {} });
  activeAnimations.clear();
  if (overlayElement) {
    overlayElement.querySelectorAll('.custom-danmaku-item').forEach(el => el.remove());
  }
  Object.values(lanes).forEach(l => l.reset(areaHeight));
  dueQueue = [];
}

// Restart from the current position (after a seek, a start, an ad or a
// switch back to our layer).
function resync() {
  cleanAll();
  const nowTenths = videoElement.currentTime * 10;
  nextIndex = lowerBound(danmakuData, nowTenths);
  lastTenths = nowTenths - 0.001;
  lastBucket = null;
  danmakuData.forEach(d => {
    // Stale in-flight AI results should be ignored; re-evaluate on demand.
    if (d.aiEvaluated === 'pending') d.aiEvaluated = false;
  });
  backfill(nowTenths * 100);
  resume();
}

// Shows the comments from just before the current position that would still
// be on screen, already part-way through. The official player only shows
// comments that start after a seek. Comments that are not checked by the AI
// yet are skipped.
function backfill(nowMs) {
  if (!overlayOn() || !display.enabled || adActive || !overlayElement) return;
  const from = lowerBound(danmakuData, (nowMs - BACKFILL_MS) / 100);
  for (let i = from; i < nextIndex; i++) {
    const d = danmakuData[i];
    if (d.isBlocked) continue;
    if (settings.aiFilterEnabled && d.aiEvaluated !== true) continue;
    const startMs = d.time * 100;
    if (renderDanmaku(d, startMs, nowMs - startMs)) stats.backfilled++;
  }
}

function onResize() {
  if (!overlayElement) return;
  areaWidth = overlayElement.clientWidth;
  areaHeight = overlayElement.clientHeight;
  Object.values(lanes).forEach(l => {
    if (l.height !== Math.floor(areaHeight)) l.reset(areaHeight);
  });
}

// --- Rendering ---------------------------------------------------------------

// Shows one comment that starts at video time `startMs`. `elapsedMs` > 0
// places it part-way through (backfill). Returns false if nothing is shown.
function renderDanmaku(d, startMs, elapsedMs = 0) {
  const mode = MODES[d.position] || 'rolling';
  if (!display.modeAllow[mode] || display.opacity === 0) return false;
  if (document.visibilityState !== 'visible') return false;

  const el = document.createElement('div');
  el.className = `custom-danmaku-item danmaku-mode-${mode}`;
  el.textContent = d.text; // textContent, never innerHTML — prevents XSS.
  el.dataset.mode = mode;
  el.dataset.sn = d.sn;
  el.style.color = typeof d.color === 'number'
    ? '#' + d.color.toString(16).padStart(6, '0')
    : (d.color || '#ffffff');
  el.style.fontSize = `${Math.floor((FONT_SIZES[d.size] || 24) * display.sizeRate)}px`;
  el.style.opacity = display.opacity;
  el.style.visibility = 'hidden';
  overlayElement.appendChild(el);

  // Measure in the DOM, then place and animate like the official player.
  // Durations and locks are in video time (playback rate 1); the animation
  // playbackRate follows the video, also when the rate changes later.
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  let lockMs;
  let durationMs;
  let keyframes;
  if (mode === 'rolling') {
    const speed = (window.screen.availWidth + width * 2) / ROLLING_UNIT_SEC / 1000; // px per ms
    lockMs = width / speed;
    durationMs = (areaWidth + width * 1.1) / speed;
    keyframes = [
      { transform: `translate3d(${areaWidth}px, 0, 0)` },
      { transform: 'translate3d(-110%, 0, 0)' },
    ];
  } else {
    lockMs = STATIC_DURATION_MS;
    durationMs = STATIC_DURATION_MS;
    keyframes = [{ visibility: 'visible' }, { visibility: 'visible' }];
  }

  if (elapsedMs >= durationMs) {
    el.remove();
    return false;
  }

  const pos = lanes[mode].allocate(height, startMs, startMs + lockMs);
  if (mode === 'bottom') el.style.bottom = `${pos}px`;
  else el.style.top = `${pos}px`;
  el.style.visibility = '';

  const anim = el.animate(keyframes, { duration: durationMs, easing: 'linear', fill: 'forwards' });
  anim.playbackRate = videoElement.playbackRate || 1;
  if (elapsedMs > 0) anim.currentTime = elapsedMs;
  activeAnimations.add(anim);

  // If the video was already paused when this comment was scheduled, hold it.
  if (videoElement.paused) anim.pause();

  const cleanup = () => {
    activeAnimations.delete(anim);
    el.remove();
  };
  anim.onfinish = cleanup;
  anim.oncancel = cleanup;

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    videoElement.pause();
    showDanmakuModal(d);
  });
  return true;
}

function removeOnScreen(predicate) {
  if (!overlayElement) return;
  overlayElement.querySelectorAll('.custom-danmaku-item').forEach(el => {
    if (!predicate(el)) return;
    el.getAnimations().forEach(a => a.cancel());
    el.remove();
  });
}

// --- Helpers -----------------------------------------------------------------

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

// First index whose time is >= t (danmakuData is sorted by time).
function lowerBound(list, t) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// First index whose time is > t.
function indexAfter(list, t) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].time <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function waitForElement(selector, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timed out waiting for ${selector}`));
    }, timeoutMs);
  });
}

init();

function showDanmakuModal(d) {
  const existing = document.getElementById('danmaku-info-modal');
  if (existing) existing.remove();

  const totalSeconds = Math.floor(d.time / 10);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  const timeStr = `${minutes}:${seconds}`;

  // Built via DOM APIs / textContent so danmaku text and userid can never
  // inject HTML into the page.
  const modal = document.createElement('div');
  modal.id = 'danmaku-info-modal';

  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('span');
  title.className = 'modal-title';
  title.textContent = 'Danmaku Info';
  const timeEl = document.createElement('span');
  timeEl.className = 'modal-time';
  timeEl.textContent = timeStr;
  header.append(title, timeEl);

  const content = document.createElement('div');
  content.className = 'modal-content';
  content.textContent = d.text;

  const meta = document.createElement('div');
  meta.className = 'modal-meta';
  meta.textContent = `Author ID: ${d.userid}`;

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-copy';
  copyBtn.textContent = 'Copy';

  const blockUserBtn = document.createElement('button');
  blockUserBtn.className = 'btn-danger btn-block-user';
  blockUserBtn.textContent = 'Block User';

  const filterTextBtn = document.createElement('button');
  filterTextBtn.className = 'btn-danger btn-filter-text';
  filterTextBtn.textContent = 'Filter Text';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-secondary btn-close';
  closeBtn.textContent = 'Close';

  actions.append(copyBtn, blockUserBtn, filterTextBtn, closeBtn);
  modal.append(header, content, meta, actions);

  modal.addEventListener('click', (e) => e.stopPropagation());
  overlayElement.appendChild(modal);

  closeBtn.onclick = () => {
    modal.remove();
    videoElement.play();
  };

  copyBtn.onclick = () => {
    navigator.clipboard.writeText(d.text);
    copyBtn.textContent = 'Copied!';
  };

  blockUserBtn.onclick = async () => {
    if (!settings.userBlocklist.includes(d.userid)) {
      settings.userBlocklist.push(d.userid);
      await chrome.storage.local.set({ settings });
    }
    modal.remove();
    processDanmaku();
    removeOnScreen(el => bySn.get(Number(el.dataset.sn))?.userid === d.userid);
    videoElement.play();
  };

  filterTextBtn.onclick = async () => {
    if (!settings.keywordBlocklist.includes(d.text)) {
      settings.keywordBlocklist.push(d.text);
      await chrome.storage.local.set({ settings });
    }
    modal.remove();
    processDanmaku();
    removeOnScreen(el => bySn.get(Number(el.dataset.sn))?.text === d.text);
    videoElement.play();
  };
}
