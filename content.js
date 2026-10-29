// content.js

const LOG = '[Danmaku Enhancer]';
const DANMU_API = 'https://api.gamer.com.tw/anime/v1/danmu.php';

// Renderer constants, matched to the official danmaku manager in
// anime_player.js.
const TIME_UNIT_MS = 200;          // official fires comments in 200 ms buckets
const STATIC_DURATION_MS = 5000;   // top / bottom comments
const ROLLING_UNIT_SEC = 12;       // speed = (screen width + 2 * text width) / 12 s
const FONT_SIZES = { 0: 16, 1: 24, 2: 28 };
const MODES = { 0: 'rolling', 1: 'top', 2: 'bottom' };
// The AI filter (Gemini Nano) is not tested enough to ship: while false it
// never runs, whatever the stored setting, and the settings page hides its switch.
const AI_FILTER_READY = false;
// Comments still waiting for the AI this long after their time are dropped.
const GRACE_TENTHS = 30;
// The AI checks comments up to this far ahead of the playhead, a few unique
// texts per request, so the soonest ones come back first. Shorter texts
// skip the AI.
const AI_AHEAD_TENTHS = 3000;
const AI_BATCH_SIZE = 4;
const AI_MIN_TEXT = 3;
const AI_SCAN_MS = 250;
// Live updates: fetch the list again this often while the video plays.
// New comments up to LIVE_CATCHUP_MS behind the playhead (for example one
// the viewer just sent) show at once, part-way through.
const LIVE_REFRESH_MS = 120000;
const LIVE_CATCHUP_MS = 8000;
// After the viewer sends a comment (/ajax/danmuSet.php), fetch the list at
// these delays; the second one covers a slow server update.
const SENT_REFRESH_DELAYS_MS = [800, 4000];
const SETTINGS_POLL_MS = 1000;
const REFETCH_DEBOUNCE_MS = 300;
// How long a danmu.php request for another episode waits for the address
// bar to show that episode (watchOfficialRefetch).
const EPISODE_URL_WAIT_MS = 1000;
const DEBUG_FLUSH_MS = 2000;
const STATS_INTERVAL_MS = 10000;
// A seek after which the video has not moved for this long while not paused
// is logged with its buffer state (watchSeekStall).
const SEEK_STALL_MS = 2500;
// How far back to look for comments still crossing the screen after a seek
// or start (a rolling comment takes at most about 12 s in fullscreen).
const BACKFILL_MS = 12000;
// Frame timing in the stats entry: a frame this long counts as slow (about
// 3 missed frames at 60 Hz). On-screen counts are sampled at this interval.
const SLOW_FRAME_MS = 50;
const COUNT_SAMPLE_MS = 250;

let currentVideoSn = null;
let bookmarks = null;
let densityCurve = null;
let ageGate = null;
let opSkip = null;
let audioProbe = null;
let opAudio = null;
let videoElement = null;
let playerElement = null;
let overlayElement = null;
let danmakuData = [];      // sorted by time; `time` is in tenths of a second
let bySn = new Map();
let byText = new Map();    // text -> comments with that text
// Info mode: sn of the informative comments (infomode.js), or null when off.
let infoSns = null;
// AI results per text (true = allowed). Kept across reloads, seeks and
// episodes, so a repeated text ("www") is checked once.
const aiVerdicts = new Map();
let aiInFlight = false;
let settings = {};
let officialKeywords = [];
let display = readOfficialDisplay();

let nextIndex = 0;         // first item in danmakuData not yet due
let lastTenths = 0;        // items up to this time were already taken
let dueQueue = [];         // due items still waiting (AI) to be rendered
// The viewer's own new comments that a reload found while the video was
// paused (paused to type); shown when playback starts again.
let ownPending = [];
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
// chrome.storage.local; the settings page exports them as a JSON file.
const debugBuffer = [];
const stats = newStats();
let frameStats = newFrameStats();
let lastFrameAt = 0;
let frameLoop = 0;           // measureFrame's requestAnimationFrame id
let lastCountAt = 0;

function newStats() {
  return { rendered: 0, backfilled: 0, lateShown: 0, droppedLate: 0, blocked: 0, aiRequested: 0, aiBlocked: 0, aiFailed: 0 };
}

function newFrameStats() {
  return { frames: 0, playingMs: 0, slowFrames: 0, maxFrameMs: 0, peakOnScreen: 0, peakOfficial: 0 };
}

// The full debug log (stats, player events, guesses) is for development and
// is on only with settings.debugMode; otherwise only errors are kept.
function debugOn() {
  return settings.debugMode === true;
}

function isErrorEvent(event, data) {
  return /error|failed/i.test(event) || (!!data && data.ok === false);
}

function dlog(event, data) {
  const error = isErrorEvent(event, data);
  if (!error && !debugOn()) return;
  (error ? console.warn : console.log)(LOG, event, data === undefined ? '' : data);
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
  if (!debugOn() || !videoElement || videoElement.paused) return;
  const f = frameStats;
  dlog('stats', {
    ...stats,
    onScreen: activeAnimations.size,
    waiting: dueQueue.length,
    nextIndex,
    total: danmakuData.length,
    aiReadySec: aiOn() ? aiReadySec() : undefined,
    fps: f.playingMs ? Math.round(f.frames * 10000 / f.playingMs) / 10 : null,
    slowFrames: f.slowFrames,
    maxFrameMs: Math.round(f.maxFrameMs),
    peakOnScreen: f.peakOnScreen,
    peakOfficial: f.peakOfficial,
  });
  Object.assign(stats, newStats());
  frameStats = newFrameStats();
}

// Frame rate while the video plays, and the most comments on screen in our
// layer and in the official one. The official layer keeps running under
// ours (only hidden), so both counts are live at the same time. It marks
// finished comments `.useless` and removes them later.
// Runs only while the video plays and debug mode is on (the stats are all
// it feeds).
function measureFrame(now) {
  if (!debugOn()) {
    frameLoop = 0;
    lastFrameAt = 0;
    return;
  }
  frameLoop = requestAnimationFrame(measureFrame);
  const f = frameStats;
  // A longer gap means the tab was hidden (no frames), not a slow frame.
  if (lastFrameAt && now - lastFrameAt < 1000) {
    const gap = now - lastFrameAt;
    f.frames++;
    f.playingMs += gap;
    if (gap > SLOW_FRAME_MS) f.slowFrames++;
    if (gap > f.maxFrameMs) f.maxFrameMs = gap;
  }
  lastFrameAt = now;
  if (now - lastCountAt >= COUNT_SAMPLE_MS) {
    lastCountAt = now;
    f.peakOnScreen = Math.max(f.peakOnScreen, activeAnimations.size);
    f.peakOfficial = Math.max(f.peakOfficial,
      playerElement.querySelectorAll('.danmu-warp .danmu:not(.useless)').length);
  }
}

function overlayOn() {
  return settings.overlayEnabled !== false;
}

// Sends one settings change to background.js, the one writer (see
// updateSettings there); storage.onChanged then applies it in every tab.
async function updateSettings(change) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATE', change });
    if (!res || !res.ok) throw new Error((res && res.error) || 'no reply');
  } catch (err) {
    dlog('error', { where: 'updateSettings', message: err.message });
  }
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

  const storage = await chrome.storage.local.get("settings");
  settings = storage.settings || {
    aiFilterEnabled: false,
    aiStrictness: 'moderate',
    keywordBlocklist: [],
    userBlocklist: []
  };
  dlog('init', { url: location.pathname + location.search, version: chrome.runtime.getManifest().version });
  DmkI18n.setLanguage(settings.uiLanguage);

  let danmuLayer;
  try {
    // No time limit: a background tab or a long wait on the rating notice
    // can delay the player.
    videoElement = await waitForElement('#ani_video_html5_api', 0);
    // The official layer. Our overlay goes inside it so both always cover
    // the same area (normal, theater and fullscreen).
    danmuLayer = await waitForElement('#ani_video .vjs-danmu', 0);
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
  const opAudioOn = () => settings.densityEnabled !== false && settings.opAudio !== false;
  opAudio = initOpAudio({
    video: videoElement,
    getVideoSn: () => currentVideoSn,
    isEnabled: opAudioOn,
    onChange: () => {
      if (opSkip) opSkip.update();
      if (densityCurve) densityCurve.update();
    },
    log: dlog,
  });
  opSkip = initOpSkip({
    video: videoElement,
    player: playerElement,
    getDanmaku: () => danmakuData,
    getVideoSn: () => currentVideoSn,
    getAudio: opAudio.result,
    isEnabled: () => settings.densityEnabled !== false,
    keepReview: debugOn,
    log: dlog,
  });
  densityCurve = initDensityCurve({
    video: videoElement,
    player: playerElement,
    // In info mode, the curve shows where the informative comments are.
    getDanmaku: () => (infoSns ? danmakuData.filter(d => infoSns.has(d.sn)) : danmakuData),
    isEnabled: () => settings.densityEnabled !== false,
    getMarks: opSkip.range,
  });
  initOpReport({
    video: videoElement,
    player: playerElement,
    getVideoSn: () => currentVideoSn,
    getResult: opSkip.result,
    isEnabled: () => settings.densityEnabled !== false,
    log: dlog,
  });
  audioProbe = initAudioProbe({
    video: videoElement,
    player: playerElement,
    getVideoSn: () => currentVideoSn,
    isEnabled: () => settings.audioProbe === true || opAudioOn(),
    keep: () => settings.audioProbe === true,
    onSecond: opAudio.onSecond,
    log: dlog,
  });
  ageGate = watchAgeGate({
    player: playerElement,
    isEnabled: () => settings.autoAgreeAgeGate !== false,
    log: dlog,
  });
  dlog('player', {
    area: [areaWidth, areaHeight],
    video: [videoElement.clientWidth, videoElement.clientHeight],
    screenWidth: window.screen.availWidth,
    display,
    settings: { overlayEnabled: overlayOn(), aiFilterEnabled: aiOn() },
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const prev = settings;
    settings = changes.settings.newValue || {};
    dlog('settings', { overlayEnabled: overlayOn(), aiFilterEnabled: aiOn() });
    DmkI18n.setLanguage(settings.uiLanguage);
    updatePlayerToggle();
    processDanmaku();
    removeOnScreen(el => bySn.get(Number(el.dataset.sn))?.isBlocked);
    opSkip.update();
    densityCurve.update();
    ageGate.check();
    audioProbe.check();
    if ((prev.overlayEnabled !== false) !== overlayOn()) applyOverlayMode();
    if ((prev.infoMode === true) !== (settings.infoMode === true)) updateInfoMode();
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
  watchSeekStall();
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
  if (AI_FILTER_READY) setInterval(aiScan, AI_SCAN_MS);
  setInterval(liveRefresh, LIVE_REFRESH_MS);

  await loadDanmaku('init');
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
    await updateSettings({ set: { overlayEnabled: !overlayOn() } });
  });
  officialButton.after(playerToggle);
  updatePlayerToggle();
}

function updatePlayerToggle() {
  if (!playerToggle) return;
  const on = overlayOn();
  playerToggle.textContent = DmkI18n.t(on ? 'player.toggleOn' : 'player.toggleOff');
  playerToggle.classList.toggle('is-on', on);
  playerToggle.title = DmkI18n.t(on ? 'player.toggleOnTitle' : 'player.toggleOffTitle');
}

// Loads (or reloads) the list. On a reload, keeps what is on screen and the
// AI results, drops comments the server no longer returns (for example from
// a user just muted), and continues from the current position.
async function loadDanmaku(reason) {
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
  danmakuData = list;
  bySn = new Map(list.map(d => [d.sn, d]));
  byText = new Map();
  for (const d of list) {
    const same = byText.get(d.text);
    if (same) same.push(d);
    else byText.set(d.text, [d]);
  }
  processDanmaku();
  updateInfoMode();
  const added = previous.size ? list.filter(d => !previous.has(d.sn)) : [];
  dlog('loaded', {
    reason,
    count: danmakuData.length,
    reload: previous.size > 0,
    added: added.length,
    removed: previous.size ? [...previous.keys()].filter(sn => !bySn.has(sn)).length : 0,
    blocked: danmakuData.filter(d => d.isBlocked).length,
    ms: Math.round(performance.now() - started),
  });
  opSkip.update();
  densityCurve.update();

  if (reason === 'sent' && videoElement.paused) {
    // Items after lastTenths still show the normal way when play starts.
    const late = added.filter(d => d.time <= lastTenths && !ownPending.some(p => p.sn === d.sn));
    if (late.length) {
      ownPending.push(...late);
      dlog('ownPending', { sns: late.map(d => d.sn) });
    }
  }

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
  showLateArrivals(added);
}

// New comments from a reload whose time already passed show at once,
// part-way through, if they are recent (for example one the viewer just
// sent; the official player shows those right away too).
function showLateArrivals(added) {
  if (!added.length || !overlayOn() || !display.enabled || adActive || videoElement.paused) return;
  const nowMs = videoElement.currentTime * 1000;
  for (const d of added) {
    const startMs = d.time * 100;
    if (d.time > lastTenths || nowMs - startMs > LIVE_CATCHUP_MS) continue;
    if (d.isBlocked || !aiReady(d)) continue;
    if (renderDanmaku(d, startMs, Math.max(0, nowMs - startMs))) stats.lateShown++;
  }
}

// Fetches the list again every LIVE_REFRESH_MS while the video plays in a
// visible tab, so comments sent by others while you watch show up.
function liveRefresh() {
  if (settings.liveUpdate === false || document.hidden || !videoElement) return;
  if (videoElement.paused || adActive || !danmakuData.length) return;
  loadDanmaku('live');
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

// Diagnostic: after a seek, logs when playback does not move although the
// video is not paused (for example a seek to 0:00 that never plays), with
// the buffered ranges, so a stall can be told apart from our own work.
function watchSeekStall() {
  let check = 0;
  videoElement.addEventListener('seeked', () => {
    clearTimeout(check);
    const at = videoElement.currentTime;
    check = setTimeout(() => {
      const v = videoElement;
      if (v.paused || adActive || Math.abs(v.currentTime - at) > 0.2) return;
      const buffered = [];
      for (let i = 0; i < v.buffered.length; i++) {
        buffered.push([Math.round(v.buffered.start(i) * 100) / 100, Math.round(v.buffered.end(i) * 100) / 100]);
      }
      dlog('seekStall', {
        at: Math.round(at * 100) / 100, readyState: v.readyState, networkState: v.networkState,
        buffered, ended: v.ended, error: v.error && v.error.code,
      });
    }, SEEK_STALL_MS);
  });
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
      if (entry.name.includes('/ajax/danmuSet.php')) {
        // The viewer sent a comment; our layer hides the official one, which
        // shows it right away.
        dlog('commentSent');
        SENT_REFRESH_DELAYS_MS.forEach(ms => setTimeout(() => loadDanmaku('sent'), ms));
        continue;
      }
      if (!entry.name.includes('/anime/v1/danmu.php')) continue;
      const own = ownFetchStarts.findIndex(t => Math.abs(t - entry.startTime) < 50);
      if (own >= 0) {
        ownFetchStarts.splice(own, 1);
        continue;
      }
      let sn = null;
      try { sn = new URL(entry.name).searchParams.get('videoSn'); } catch (_) {}
      dlog('officialRefetch', { videoSn: sn, ownPending: ownFetchStarts.length });
      if (sn && sn !== currentVideoSn) {
        followEpisode(sn);
        continue;
      }
      clearTimeout(timer);
      timer = setTimeout(() => loadDanmaku('official'), REFETCH_DEBOUNCE_MS);
    }
  }).observe({ type: 'resource' });

  // Another episode's list: follow it only when the address bar shows that
  // episode too, so a danmu.php request from some other script on the page
  // (another extension, a console test) cannot switch the episode. The
  // player has always pushed the new ?sn= by the time its request shows
  // here; wait once in case it is late.
  function followEpisode(sn, waited = false) {
    if (new URLSearchParams(location.search).get('sn') === sn) {
      if (sn === currentVideoSn) return;
      changeEpisode(sn);
      clearTimeout(timer);
      timer = setTimeout(() => loadDanmaku('official'), REFETCH_DEBOUNCE_MS);
    } else if (!waited) {
      setTimeout(() => followEpisode(sn, true), EPISODE_URL_WAIT_MS);
    } else {
      dlog('foreignDanmuFetch', { videoSn: sn, url: location.search });
    }
  }
}

// Drops the old episode's list; the caller loads the new one.
function changeEpisode(sn) {
  dlog('episodeChange', { from: currentVideoSn, to: sn, url: location.search });
  currentVideoSn = sn;
  cleanAll();
  danmakuData = [];
  bySn = new Map();
  byText = new Map();
  nextIndex = 0;
  lastTenths = 0;
  lastBucket = null;
  if (opSkip) opSkip.update();
  if (densityCurve) densityCurve.update();
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
    loadDanmaku('geos');
    return;
  }
  if (!display.enabled) {
    cleanAll();
    return;
  }
  if (display.opacity !== prev.opacity) {
    applyOpacity();
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
    d.isBlocked = !passesBasicFilter(d) ||
      (aiOn() && aiVerdicts.get(d.text) === false);
  });
}

function aiOn() {
  return AI_FILTER_READY && settings.aiFilterEnabled === true;
}

// True when the comment may show as far as the AI is concerned.
function aiReady(d) {
  return !aiOn() || (d.text || '').length < AI_MIN_TEXT || aiVerdicts.has(d.text);
}

// Checks comments with the AI ahead of the playhead, soonest first, one
// request at a time. Runs while paused too, so the buffer grows.
function aiScan() {
  if (!aiOn() || aiInFlight || !videoElement || !danmakuData.length) return;
  const nowTenths = videoElement.currentTime * 10;
  const texts = [];
  for (let i = lowerBound(danmakuData, nowTenths - GRACE_TENTHS); i < danmakuData.length; i++) {
    const d = danmakuData[i];
    if (d.time > nowTenths + AI_AHEAD_TENTHS) break;
    if (d.isBlocked || aiReady(d) || texts.includes(d.text)) continue;
    texts.push(d.text);
    if (texts.length === AI_BATCH_SIZE) break;
  }
  if (!texts.length) return;

  aiInFlight = true;
  stats.aiRequested += texts.length;
  const started = performance.now();
  chrome.runtime.sendMessage({ type: 'AI_FILTER_BATCH', texts }, (res) => {
    aiInFlight = false;
    const ok = !chrome.runtime.lastError && res && res.success;
    if (!ok) {
      stats.aiFailed += texts.length;
      dlog('aiBatchFailed', {
        size: texts.length,
        error: chrome.runtime.lastError?.message || res?.error || 'no response',
      });
    } else if (performance.now() - started > 3000) {
      dlog('aiBatchSlow', { size: texts.length, ms: Math.round(performance.now() - started) });
    }
    // Fail open: a text the AI could not check is shown.
    const results = new Map(ok ? res.results.map(r => [r.text, r.allowed]) : []);
    for (const text of texts) {
      const allowed = results.get(text) !== false;
      aiVerdicts.set(text, allowed);
      if (allowed) continue;
      stats.aiBlocked++;
      dlog('aiBlockedText', { text });
      (byText.get(text) || []).forEach(d => { d.isBlocked = true; });
    }
  });
}

// Seconds of comments ahead of the playhead the AI has already checked.
function aiReadySec() {
  const nowTenths = videoElement.currentTime * 10;
  for (let i = lowerBound(danmakuData, nowTenths); i < danmakuData.length; i++) {
    const d = danmakuData[i];
    if (d.time > nowTenths + AI_AHEAD_TENTHS) break;
    if (!d.isBlocked && !aiReady(d)) return Math.round(d.time - nowTenths) / 10;
  }
  return AI_AHEAD_TENTHS / 10;
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
    if (!aiReady(d)) return true;
    if (renderDanmaku(d, nowMs)) stats.rendered++;
    return false;
  });
}

function pause() {
  cancelAnimationFrame(rafId);
  rafId = 0;
  cancelAnimationFrame(frameLoop);
  frameLoop = 0;
  lastFrameAt = 0;
  activeAnimations.forEach(a => { try { a.pause(); } catch (_) {} });
}

function resume() {
  if (videoElement.paused || videoElement.seeking) return;
  activeAnimations.forEach(a => { try { a.play(); } catch (_) {} });
  if (ownPending.length) {
    const pending = ownPending.map(d => bySn.get(d.sn)).filter(Boolean);
    ownPending = [];
    showLateArrivals(pending);
  }
  if (!rafId) rafId = requestAnimationFrame(tick);
  if (!frameLoop && debugOn()) frameLoop = requestAnimationFrame(measureFrame);
}

function cleanAll() {
  activeAnimations.forEach(a => { try { a.cancel(); } catch (_) {} });
  activeAnimations.clear();
  if (overlayElement) {
    overlayElement.querySelectorAll('.custom-danmaku-item').forEach(el => el.remove());
  }
  Object.values(lanes).forEach(l => l.reset(areaHeight));
  dueQueue = [];
  // A seek, an ad or another episode: backfill shows them if still near.
  ownPending = [];
  document.getElementById('danmaku-info-modal')?.remove();
}

// Restart from the current position (after a seek, a start, an ad or a
// switch back to our layer).
function resync() {
  cleanAll();
  const nowTenths = videoElement.currentTime * 10;
  nextIndex = lowerBound(danmakuData, nowTenths);
  lastTenths = nowTenths - 0.001;
  lastBucket = null;
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
    if (!aiReady(d)) continue;
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

// --- Info mode -----------------------------------------------------------------

// Finds the informative comments again (after a load, or when the mode is
// turned on or off) and sets the opacity of those on screen.
function updateInfoMode() {
  infoSns = null;
  if (settings.infoMode === true && danmakuData.length) {
    // During an ad the video has the ad's length, so take at least the
    // last comment plus 30 s.
    const lastSec = danmakuData[danmakuData.length - 1].time / 10;
    const duration = Math.max(lastSec + 30, videoElement.duration || 0);
    const started = performance.now();
    const found = findInfoComments(danmakuData, duration);
    infoSns = found.sns;
    const types = {};
    found.blocks.forEach(b => { types[b.type] = (types[b.type] || 0) + 1; });
    dlog('infoMode', {
      comments: infoSns.size,
      blocks: types,
      ms: Math.round(performance.now() - started),
    });
  }
  applyOpacity();
  if (densityCurve) densityCurve.update();
}

// Info mode shows informative comments at full opacity and dims the rest.
// An official opacity of 0 hides all of them.
function itemOpacity(d) {
  if (!infoSns || display.opacity === 0) return display.opacity;
  return d && infoSns.has(d.sn) ? 1 : display.opacity * INFO_DIM;
}

function applyOpacity() {
  if (!overlayElement) return;
  overlayElement.querySelectorAll('.custom-danmaku-item').forEach(el => {
    el.style.opacity = itemOpacity(bySn.get(Number(el.dataset.sn)));
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
  el.style.opacity = itemOpacity(d);
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
    const wasPlaying = !videoElement.paused;
    videoElement.pause();
    showDanmakuModal(d, wasPlaying);
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

// `timeoutMs` 0 waits as long as it takes.
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

    const timer = timeoutMs > 0 && setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timed out waiting for ${selector}`));
    }, timeoutMs);
  });
}

init();

// `wasPlaying`: play again on close only if the video was playing.
function showDanmakuModal(d, wasPlaying) {
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
  header.className = 'dmk-modal-header';
  const title = document.createElement('span');
  title.className = 'dmk-modal-title';
  title.textContent = DmkI18n.t('modal.title');
  const timeEl = document.createElement('span');
  timeEl.className = 'dmk-modal-time';
  timeEl.textContent = timeStr;
  header.append(title, timeEl);

  const content = document.createElement('div');
  content.className = 'dmk-modal-content';
  content.textContent = d.text;

  const meta = document.createElement('div');
  meta.className = 'dmk-modal-meta';
  meta.textContent = DmkI18n.t('modal.author', { id: d.userid });

  const actions = document.createElement('div');
  actions.className = 'dmk-modal-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'dmk-btn-copy';
  copyBtn.textContent = DmkI18n.t('modal.copy');

  const blockUserBtn = document.createElement('button');
  blockUserBtn.className = 'dmk-btn-danger dmk-btn-block-user';
  blockUserBtn.textContent = DmkI18n.t('modal.blockUser');

  const filterTextBtn = document.createElement('button');
  filterTextBtn.className = 'dmk-btn-danger dmk-btn-filter-text';
  filterTextBtn.textContent = DmkI18n.t('modal.filterText');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'dmk-btn-secondary dmk-btn-close';
  closeBtn.textContent = DmkI18n.t('modal.close');

  actions.append(copyBtn, blockUserBtn, filterTextBtn, closeBtn);
  modal.append(header, content, meta, actions);

  modal.addEventListener('click', (e) => e.stopPropagation());
  overlayElement.appendChild(modal);

  const close = () => {
    modal.remove();
    if (wasPlaying) videoElement.play();
  };

  closeBtn.onclick = close;

  copyBtn.onclick = () => {
    navigator.clipboard.writeText(d.text);
    copyBtn.textContent = DmkI18n.t('modal.copied');
  };

  blockUserBtn.onclick = () => {
    // The local copy changes at once, so the comments go now; the stored
    // settings change through background.js.
    settings.userBlocklist = settings.userBlocklist || [];
    if (!settings.userBlocklist.includes(d.userid)) {
      settings.userBlocklist.push(d.userid);
      updateSettings({ add: { userBlocklist: d.userid } });
    }
    close();
    processDanmaku();
    removeOnScreen(el => bySn.get(Number(el.dataset.sn))?.userid === d.userid);
  };

  filterTextBtn.onclick = () => {
    settings.keywordBlocklist = settings.keywordBlocklist || [];
    if (!settings.keywordBlocklist.includes(d.text)) {
      settings.keywordBlocklist.push(d.text);
      updateSettings({ add: { keywordBlocklist: d.text } });
    }
    close();
    processDanmaku();
    removeOnScreen(el => bySn.get(Number(el.dataset.sn))?.text === d.text);
  };
}
