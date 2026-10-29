// opaudio.js
//
// Finds the OP from the sound, for works with too few danmaku for
// opskip.js. The same OP song plays in each episode of a work, and its
// per-second loudness and spectrum (from audioprobe.js) repeat within a
// fraction of a dB. So:
// - Each played second of the first part of an episode is kept per work
//   (title without the episode number), one chrome.storage.local key per
//   work (AUDIO_OP_WORK_PREFIX + work): the newest AUDIO_OP_EPISODES
//   episodes, for the newest AUDIO_OP_WORKS works (AUDIO_OP_INDEX). Saving
//   reads the work's key again and merges, so tabs do not erase each
//   other's episodes.
// - Every AUDIO_OP_MATCH_EVERY_SEC, the last AUDIO_OP_WINDOW_SEC played
//   seconds are compared with the kept episodes of the same work at every
//   time shift. A run of at least AUDIO_OP_MIN_RUN_SEC "same" seconds (see
//   audioSame) with few pauses (a song, not a recap of talk), starting in
//   the first OP_LATEST_FRACTION of both episodes, is the OP. The run is
//   then grown over all kept seconds at that shift to find its edges.
// - A run whose both edges were seen (the sound just past them differs;
//   silence counts) and that is OP_MIN_SEC–OP_MAX_SEC long becomes the
//   work's OP profile, and a longer such run replaces it. Later episodes
//   match the profile after AUDIO_OP_PROFILE_RUN_SEC, which gives the start
//   and the end before the end has played.
// Episode 1, .5 episodes and films are neither kept nor used for a
// profile: their OP is often missing, moved or different.
// The result for each episode is kept too, so a revisit knows its OP at
// once. opskip.js prefers it over the danmaku guess.

const AUDIO_OP_INDEX = 'opAudio:index';
const AUDIO_OP_WORK_PREFIX = 'opAudio:w:';
const AUDIO_OP_WORKS = 40;
const AUDIO_OP_EPISODES = 8;
const AUDIO_OP_RESULTS = 60;          // per work
const AUDIO_OP_MATCH_EVERY_SEC = 4;
const AUDIO_OP_WINDOW_SEC = 45;       // last played seconds compared each time
const AUDIO_OP_MIN_RUN_SEC = 20;
const AUDIO_OP_PROFILE_RUN_SEC = 10;
const AUDIO_OP_MAX_MISS = 2;          // mismatched seconds in a row inside a run
const AUDIO_OP_MAX_MISSING = 3;       // seconds without data stepped over
const AUDIO_OP_MAX_GAP = 0.15;        // mean pause share of a song run
const AUDIO_OP_MIN_FRAMES = 6;        // fewer: a throttled background tab
const AUDIO_OP_SILENT_DB = -60;
const AUDIO_OP_SAVE_MS = 15000;
// Seconds kept per episode: the OP starts in the first OP_LATEST_FRACTION
// and may run OP_MAX_SEC past it.

// Kept row: [t, db, gap, cent, low, mid, high]; t is the end of the second.
// A silent second stays (it ends a run); audioprobe.js drops the seconds of
// a stale track, so a missing second is unknown, not silent.
function audioOpRow(probeRow) {
  const [t, db, gap, , cent, low, mid, high, , , n] = probeRow;
  if (n < AUDIO_OP_MIN_FRAMES) return null;
  return [t, db, gap, cent, low, mid, high];
}

// Two seconds sound the same: loudness, brightness and band balance agree.
function audioSame(a, b) {
  if (a[1] < AUDIO_OP_SILENT_DB || b[1] < AUDIO_OP_SILENT_DB) return false;
  return Math.abs(a[1] - b[1]) <= 1.5 &&
    Math.abs(Math.log(a[3] + 1) - Math.log(b[3] + 1)) <= 0.35 &&
    Math.abs(a[4] - b[4]) + Math.abs(a[5] - b[5]) + Math.abs(a[6] - b[6]) <= 0.3;
}

function audioByTime(rows) {
  const map = new Map();
  for (const r of rows) map.set(r[0], r);
  return map;
}

// The run of same seconds through `from` (a time in `a`) at shift `lag`
// (b time = a time + lag): { start, end, length, gap, startSeen, endSeen }
// in `a` times, or null. An edge is "seen" when the sound just past it
// differs in both, or either falls silent; not when the data just stops.
// A few seconds without data (a dropped stale-track second) are stepped
// over.
function audioGrowRun(a, b, lag, from) {
  const same = (t) => {
    const x = a.get(t);
    const y = b.get(t + lag);
    if (!x || !y) return null;
    return audioSame(x, y);
  };
  if (!same(from)) return null;
  const walk = (step) => {
    let edge = from;
    let miss = 0;
    let missing = 0;
    for (let t = from + step; ; t += step) {
      const s = same(t);
      if (s === null) {
        // The data stops: seen only if a different second came first.
        if (++missing > AUDIO_OP_MAX_MISSING) return { edge, seen: miss > 0 };
        continue;
      }
      missing = 0;
      // A silent second ends the run: OPs are bounded by silence, and a
      // song rarely falls silent for a whole second inside.
      if (a.get(t)[1] < AUDIO_OP_SILENT_DB || b.get(t + lag)[1] < AUDIO_OP_SILENT_DB) {
        return { edge, seen: true };
      }
      if (s) {
        edge = t;
        miss = 0;
      } else if (++miss > AUDIO_OP_MAX_MISS) {
        return { edge, seen: true };
      }
    }
  };
  const left = walk(-1);
  const right = walk(1);
  let gap = 0;
  let count = 0;
  for (let t = left.edge; t <= right.edge; t++) {
    const x = a.get(t);
    if (x) {
      gap += x[2];
      count++;
    }
  }
  return {
    start: left.edge,
    end: right.edge,
    length: right.edge - left.edge + 1,
    gap: count ? gap / count : 1,
    startSeen: left.seen,
    endSeen: right.seen,
  };
}

// The longest song-like run between the seconds of `a` in (from, to] and
// anywhere in `b`, both starting early enough: { lag, run } or null.
function audioFindRun(a, b, { from = -Infinity, to = Infinity, minRun = AUDIO_OP_MIN_RUN_SEC,
  aLatest = Infinity, bLatest = Infinity } = {}) {
  const recent = [...a.keys()].filter(t => t > from && t <= to).sort((x, y) => x - y);
  if (!recent.length || !b.size) return null;
  let bMin = Infinity;
  let bMax = -Infinity;
  for (const t of b.keys()) {
    if (t < bMin) bMin = t;
    if (t > bMax) bMax = t;
  }
  let best = null;
  for (let lag = bMin - recent[recent.length - 1]; lag <= bMax - recent[0]; lag++) {
    // Count same seconds in the window first; grow only promising shifts.
    const hits = recent.filter((t) => {
      const x = a.get(t);
      const y = b.get(t + lag);
      return x && y && audioSame(x, y);
    });
    if (!hits.length || hits.length < Math.min(minRun, recent.length) * 0.6) continue;
    // Grow from each hit outside the runs grown so far: a chance hit in
    // other sound can come before the real run.
    let covered = -Infinity;
    for (const seed of hits) {
      if (seed <= covered) continue;
      const run = audioGrowRun(a, b, lag, seed);
      if (!run) continue;
      covered = run.end;
      if (run.length < minRun || run.gap > AUDIO_OP_MAX_GAP) continue;
      if (run.start - 1 > aLatest || run.start - 1 + lag > bLatest) continue;
      if (!best || run.length > best.run.length) best = { lag, run };
    }
  }
  return best;
}

// Work key and episode label from a title like "轉生就是劍 第二季 [5]".
function audioWorkOf(title) {
  const m = String(title).match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
  return m ? { work: m[1], label: m[2] } : { work: String(title), label: '' };
}

// Only regular episodes teach the OP.
function audioLearns(label, film) {
  return !film && /^\d+$/.test(label) && Number(label) !== 1;
}

// An OP in seconds of video time from a run: row t is the end of its second.
function audioOpFromRun(run) {
  return { start: run.start - 1, end: run.end };
}

function initOpAudio({ video, getVideoSn, isEnabled, onChange, log }) {
  // This episode. `entry` is its work's stored object, null while loading.
  let cur = { sn: null, rows: new Map() };
  let sinceMatch = 0;
  const maps = new WeakMap();  // kept rows array -> audioByTime map

  const title = () => document.title.replace(/\s*線上看.*$/, '');
  const isFilm = () => video.duration >= OP_FILM_MIN_SEC || OP_FILM_TITLE_RE.test(document.title);
  const byTime = (rows) => {
    let map = maps.get(rows);
    if (!map) maps.set(rows, map = audioByTime(rows));
    return map;
  };

  // Switches to `sn`, saving the previous episode first. The title names
  // `sn` only when the page shows it.
  function startEpisode(sn) {
    const old = cur;
    const { work, label } = sn === getVideoSn() ? audioWorkOf(title()) : { work: old.work, label: '' };
    const film = isFilm();
    cur = {
      sn, work, label, film,
      learns: audioLearns(label, film),
      entry: null,
      rows: new Map(),
      result: null,
      dirty: false,
    };
    sinceMatch = 0;
    save(old);
    const mine = cur;
    loadWork(work).then((entry) => {
      if (cur !== mine) return;
      mine.entry = entry;
      const kept = entry.episodes[sn];
      // Seconds played while loading are newer than the kept ones.
      if (kept) for (const r of kept.rows) if (!mine.rows.has(r[0])) mine.rows.set(r[0], r);
      mine.result = entry.results[sn] || null;
      onChange();
    });
  }

  async function loadWork(work) {
    const key = AUDIO_OP_WORK_PREFIX + work;
    try {
      const got = await chrome.storage.local.get(key);
      return got[key] || { episodes: {}, results: {} };
    } catch (err) {
      log('opAudioError', { step: 'load', error: String(err) });
      return { episodes: {}, results: {} };
    }
  }

  // The site may change the title just after the new source loads.
  function followTitle() {
    const now = audioWorkOf(title());
    if (now.work !== cur.work) return false;
    if (now.label !== cur.label) {
      cur.label = now.label;
      cur.film = isFilm();
      const learns = audioLearns(cur.label, cur.film);
      if (cur.learns && !learns) {
        cur.removed = true;
        if (cur.entry) delete cur.entry.episodes[cur.sn];
      }
      cur.learns = learns;
      cur.dirty = true;
    }
    return true;
  }

  // Called by audioprobe.js for each finished second of video, with the
  // episode that second belongs to.
  function onSecond(rowSn, probeRow) {
    if (!isEnabled() || !rowSn) return;
    // The title is the page's episode; the old source can play on a moment
    // after the page has moved to the next one.
    if (rowSn !== cur.sn) startEpisode(rowSn);
    else if (rowSn === getVideoSn() && !followTitle()) startEpisode(rowSn);
    const row = audioOpRow(probeRow);
    const duration = video.duration;
    if (!row || !(duration > 0) || row[0] > duration * OP_LATEST_FRACTION + OP_MAX_SEC) return;
    cur.rows.set(row[0], row);
    if (cur.learns) cur.dirty = true;
    if (++sinceMatch >= AUDIO_OP_MATCH_EVERY_SEC) {
      sinceMatch = 0;
      match();
    }
  }

  function match() {
    const c = cur;
    const e = c.entry;
    if (!e) return;
    // Nothing left to learn: the end is known and the profile is as long.
    if (c.result && c.result.endKnown && e.profile &&
        e.profile.length >= c.result.end - c.result.start) return;

    const latest = video.duration * OP_LATEST_FRACTION;
    const to = Math.floor(video.currentTime);   // the last finished second
    const from = to - AUDIO_OP_WINDOW_SEC;

    // The profile knows the end before it plays.
    let fromProfile = null;
    if (e.profile) {
      const hit = audioFindRun(c.rows, byTime(e.profile.rows), {
        from, to, minRun: AUDIO_OP_PROFILE_RUN_SEC, aLatest: latest,
      });
      if (hit) {
        // Profile times are its source episode's; shift its edges here.
        const start = e.profile.start - hit.lag;
        fromProfile = { start, end: start + e.profile.length, source: 'audio-profile', endKnown: true };
      }
    }

    let fromEpisodes = null;
    for (const [otherSn, other] of Object.entries(e.episodes)) {
      if (otherSn === c.sn) continue;
      const hit = audioFindRun(c.rows, byTime(other.rows), {
        from, to, aLatest: latest,
        bLatest: (other.duration || video.duration) * OP_LATEST_FRACTION,
      });
      if (!hit || (fromEpisodes && hit.run.length <= fromEpisodes.length)) continue;
      fromEpisodes = {
        ...audioOpFromRun(hit.run),
        length: hit.run.length,
        source: 'audio-match',
        endKnown: hit.run.endSeen,
        startKnown: hit.run.startSeen,
        lag: hit.lag,
        otherSn,
      };
      if (hit.run.startSeen && hit.run.endSeen && c.learns &&
          hit.run.length >= OP_MIN_SEC && hit.run.length <= OP_MAX_SEC &&
          (!e.profile || hit.run.length > e.profile.length)) {
        learnProfile(c, hit.run);
      }
    }

    // A whole run between episodes wins; then the profile; then a run whose
    // end has not played, taken as OP_DEFAULT_SEC long.
    let found = fromEpisodes && fromEpisodes.endKnown ? fromEpisodes : fromProfile || fromEpisodes;
    if (!found) return;
    found = { ...found };
    if (!found.endKnown) {
      found.end = Math.min(Math.max(found.end, found.start + OP_DEFAULT_SEC), Math.floor(video.duration) - 1);
    }
    found.start = Math.max(0, found.start);
    if (c.result && c.result.start === found.start && c.result.end === found.end &&
        c.result.endKnown === !!found.endKnown) return;
    c.result = { start: found.start, end: found.end, source: found.source, endKnown: !!found.endKnown, at: Date.now() };
    e.results[c.sn] = c.result;
    c.dirty = true;
    log('opAudio', { sn: c.sn, ...found });
    onChange();
  }

  function learnProfile(c, run) {
    c.entry.profile = {
      sn: c.sn,
      start: run.start - 1,
      length: run.length,
      rows: [...c.rows.values()].filter(r => r[0] >= run.start && r[0] <= run.end)
        .sort((x, y) => x[0] - y[0]),
      at: Date.now(),
    };
    c.dirty = true;
    log('opAudioProfile', { work: c.work, sn: c.sn, start: c.entry.profile.start, length: run.length });
  }

  // Writes one episode's work: reads the stored copy again and merges by
  // time, so another tab's newer episodes, results and profile stay.
  async function save(c = cur) {
    if (!c.dirty || !c.entry || !c.work) return;
    c.dirty = false;
    const now = Date.now();
    if (c.learns && c.rows.size) {
      c.entry.episodes[c.sn] = {
        label: c.label,
        duration: Math.round(video.duration) || undefined,
        rows: [...c.rows.values()].sort((x, y) => x[0] - y[0]),
        at: now,
      };
    }
    const key = AUDIO_OP_WORK_PREFIX + c.work;
    try {
      const { [key]: stored = { episodes: {}, results: {} } } = await chrome.storage.local.get(key);
      const newer = (x, y) => (!y || (x && x.at >= y.at) ? x : y);
      const merged = { episodes: {}, results: {}, at: now };
      for (const part of ['episodes', 'results']) {
        for (const id of new Set([...Object.keys(stored[part] || {}), ...Object.keys(c.entry[part])])) {
          merged[part][id] = newer(c.entry[part][id], (stored[part] || {})[id]);
        }
      }
      if (c.removed) delete merged.episodes[c.sn];
      const profile = [c.entry.profile, stored.profile].filter(Boolean)
        .sort((x, y) => y.length - x.length || y.at - x.at)[0];
      if (profile) merged.profile = profile;
      audioPrune(merged.episodes, AUDIO_OP_EPISODES);
      audioPrune(merged.results, AUDIO_OP_RESULTS);
      await chrome.storage.local.set({ [key]: merged });
      if (cur === c) c.entry = merged;

      const { [AUDIO_OP_INDEX]: index = {} } = await chrome.storage.local.get(AUDIO_OP_INDEX);
      index[c.work] = now;
      const works = Object.keys(index).sort((x, y) => index[y] - index[x]);
      const old = works.slice(AUDIO_OP_WORKS);
      for (const w of old) delete index[w];
      await chrome.storage.local.set({ [AUDIO_OP_INDEX]: index });
      if (old.length) await chrome.storage.local.remove(old.map(w => AUDIO_OP_WORK_PREFIX + w));
    } catch (err) {
      c.dirty = true;
      log('opAudioError', { step: 'save', error: String(err) });
    }
  }

  // A revisit: show the kept result before any sound plays.
  function episodeShown() {
    if (!isEnabled()) return;
    const sn = getVideoSn();
    if (sn && sn !== cur.sn) startEpisode(sn);
  }

  setInterval(() => save(), AUDIO_OP_SAVE_MS);
  window.addEventListener('pagehide', () => save());
  video.addEventListener('loadedmetadata', episodeShown);
  episodeShown();

  return {
    onSecond,
    // For opskip.js: this episode's OP from the sound, or null.
    result: () => (isEnabled() && cur.sn === getVideoSn() ? cur.result : null),
  };
}

// Keeps the `max` newest entries (by .at) of an object.
function audioPrune(obj, max) {
  const ids = Object.keys(obj).sort((x, y) => obj[y].at - obj[x].at);
  for (const id of ids.slice(max)) delete obj[id];
}
