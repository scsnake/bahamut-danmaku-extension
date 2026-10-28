// audioprobe.js
//
// Test tool (settings.audioProbe, off by default): records a few audio
// numbers per second of playback, to learn whether the sound can tell a
// song (the OP) from talk. Nothing is decided from them yet.
//
// - video.captureStream() copies the element's output; playback, volume and
//   the site's own audio are not changed. The player uses MSE (a blob: URL)
//   without EME, so the samples should be readable (unverified).
// - An AnalyserNode is sampled every AUDIO_FRAME_MS; each second of video
//   time becomes one row (see AUDIO_COLUMNS). Ads are skipped.
// - When the element's source changes (ad -> episode, next episode), the
//   captured stream gets a new audio track and the old one stays "live" but
//   silent. A capture taken right at that change can stay silent too, while
//   one taken a moment later carries the sound (Chrome, tested with MSE). So
//   the probe uses the newest track and captures again whenever a track
//   gives only zero samples for AUDIO_RECAPTURE_SEC of playback.
// - Rows are kept per episode in chrome.storage.local (AUDIO_STORE, newest
//   AUDIO_MAX_EPISODES) and exported from the popup with the debug log.
//   The debug log gets the start, the track changes and a silence check.

const AUDIO_FRAME_MS = 50;
const AUDIO_FFT_SIZE = 2048;
const AUDIO_BEAT_SEC = 6;            // flux history for the beat score
const AUDIO_GAP_SEC = 2;             // loudness history for the pause share
const AUDIO_SAVE_MS = 10000;
const AUDIO_SILENCE_CHECK_SEC = 5;
const AUDIO_RECAPTURE_SEC = 1;
const AUDIO_RECAPTURE_GAP_MS = 2000;
const AUDIO_STORE = 'audioProbe';
const AUDIO_MAX_EPISODES = 30;
const AUDIO_MIN_VIDEO_SEC = 60;      // shorter videos are pre-roll ads
// One row per second of video time:
// t       video time at the end of the second (s)
// db      mean loudness (dBFS)
// gap     share of frames in the last AUDIO_GAP_SEC far below their mean
//         loudness (pauses: high in talk, low in songs)
// flat    spectral flatness, 100 Hz–8 kHz (0 = tonal, 1 = noise)
// cent    spectral centroid (Hz)
// low/mid/high  energy share below 250 Hz, 250 Hz–4 kHz, above 4 kHz
// flux    mean spectral flux (onset strength)
// beat    strongest autocorrelation of the flux at 0.25–1.5 s lags over the
//         last AUDIO_BEAT_SEC (a steady beat scores high)
// n       frames in this second (fewer when the tab is in the background)
const AUDIO_COLUMNS = ['t', 'db', 'gap', 'flat', 'cent', 'low', 'mid', 'high', 'flux', 'beat', 'n'];

function initAudioProbe({ video, player, getVideoSn, isEnabled, log }) {
  let ctx = null;
  let analyser = null;
  let stream = null;
  let source = null;
  let track = null;
  let timer = 0;
  let saveTimer = 0;
  let rows = {};          // sn -> rows not saved yet
  const meta = {};        // sn -> { title, duration } when its rows were taken
  let second = null;      // the frames of the current video second
  let prevMag = null;
  const flux = [];        // per-frame flux, last AUDIO_BEAT_SEC
  const loud = [];        // per-frame rms, last AUDIO_GAP_SEC
  let silentFrames = 0;   // zero frames on this track so far (-1: reported)
  let zeroRun = 0;        // zero frames in a row
  let lastCapture = 0;
  let recaptures = 0;
  let heard = false;

  function check() {
    if (isEnabled()) start();
    else stop();
  }

  function start() {
    if (timer) return;
    try {
      ctx = ctx || new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = AUDIO_FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      capture();
    } catch (err) {
      log('audioProbeError', { step: 'start', error: String(err) });
      return;
    }
    timer = setInterval(frame, AUDIO_FRAME_MS);
    saveTimer = setInterval(save, AUDIO_SAVE_MS);
    log('audioProbe', {
      state: 'started', context: ctx.state, sampleRate: ctx.sampleRate,
      tracks: stream.getAudioTracks().length, muted: video.muted, volume: video.volume,
    });
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    clearInterval(saveTimer);
    timer = 0;
    save();
    release();
    log('audioProbe', { state: 'stopped' });
  }

  function capture() {
    lastCapture = performance.now();
    zeroRun = 0;
    release();
    stream = video.captureStream();
    stream.addEventListener('addtrack', connect);
    connect();
  }

  function release() {
    if (source) source.disconnect();
    source = null;
    track = null;
    if (stream) {
      stream.removeEventListener('addtrack', connect);
      // Stops only this copy; the element keeps playing.
      stream.getTracks().forEach(t => t.stop());
    }
    stream = null;
  }

  // The newest live audio track carries the current source.
  function connect() {
    const live = stream.getAudioTracks().filter(t => t.readyState === 'live');
    const newest = live[live.length - 1];
    if (!newest || newest === track) return;
    track = newest;
    if (source) source.disconnect();
    source = ctx.createMediaStreamSource(new MediaStream([track]));
    source.connect(analyser);   // not to ctx.destination: nothing is played twice
    heard = false;
    silentFrames = 0;
    log('audioProbe', { state: 'track', id: track.id.slice(0, 8), tracks: live.length, context: ctx.state });
  }

  function frame() {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const duration = video.duration;
    if (video.paused || video.seeking || player.classList.contains('vjs-ad-playing') ||
        !(duration >= AUDIO_MIN_VIDEO_SEC)) {
      second = null;
      return;
    }
    if (!source) connect();

    const bins = analyser.frequencyBinCount;
    const wave = new Float32Array(AUDIO_FFT_SIZE);
    const spec = new Float32Array(bins);
    analyser.getFloatTimeDomainData(wave);
    analyser.getFloatFrequencyData(spec);

    let sq = 0;
    for (const v of wave) sq += v * v;
    const rms = Math.sqrt(sq / wave.length);
    const hzPerBin = ctx.sampleRate / AUDIO_FFT_SIZE;
    const mag = new Float32Array(bins);
    let total = 0;
    let weighted = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    let logSum = 0;
    let linSum = 0;
    let flatBins = 0;
    let rise = 0;
    for (let i = 1; i < bins; i++) {
      const p = Number.isFinite(spec[i]) ? 10 ** (spec[i] / 10) : 0;
      const hz = i * hzPerBin;
      mag[i] = Math.sqrt(p);
      total += p;
      weighted += p * hz;
      if (hz < 250) low += p;
      else if (hz < 4000) mid += p;
      else high += p;
      if (hz >= 100 && hz <= 8000) {
        logSum += Math.log(p + 1e-20);
        linSum += p;
        flatBins++;
      }
      if (prevMag) rise += Math.max(0, mag[i] - prevMag[i]);
    }
    prevMag = mag;
    const magSum = mag.reduce((a, b) => a + b, 0);
    const f = magSum ? rise / magSum : 0;
    audioPush(flux, f, AUDIO_BEAT_SEC);
    audioPush(loud, rms, AUDIO_GAP_SEC);

    // Zero samples while playing: the track is stale (captured muting does
    // not zero it), so capture again.
    zeroRun = rms > 1e-5 ? 0 : zeroRun + 1;
    if (zeroRun > AUDIO_RECAPTURE_SEC * 1000 / AUDIO_FRAME_MS &&
        performance.now() - lastCapture > AUDIO_RECAPTURE_GAP_MS) {
      recaptures++;
      if (recaptures <= 20) log('audioProbe', { state: 'recapture', count: recaptures });
      capture();
    }

    // Silence check, once per track: all-zero samples while playing.
    if (!heard) {
      if (rms > 1e-5) {
        heard = true;
        log('audioProbe', { state: 'sound', db: audioRound(20 * Math.log10(rms), 1) });
      } else if (silentFrames >= 0 &&
          ++silentFrames > AUDIO_SILENCE_CHECK_SEC * 1000 / AUDIO_FRAME_MS) {
        log('audioProbe', { state: 'silent', context: ctx.state, muted: video.muted });
        silentFrames = -1;
      }
    }

    const sec = Math.floor(video.currentTime);
    if (second && second.sec !== sec) finishSecond();
    if (!second || second.sec !== sec) second = { sec, n: 0, db: 0, flat: 0, cent: 0, low: 0, mid: 0, high: 0, flux: 0 };
    second.n++;
    second.db += 20 * Math.log10(rms + 1e-10);
    second.flat += linSum ? Math.exp(logSum / flatBins) / (linSum / flatBins) : 0;
    second.cent += total ? weighted / total : 0;
    second.low += total ? low / total : 0;
    second.mid += total ? mid / total : 0;
    second.high += total ? high / total : 0;
    second.flux += f;
  }

  function finishSecond() {
    const s = second;
    const n = s.n;
    const mean = loud.reduce((a, b) => a + b, 0) / (loud.length || 1);
    const gap = loud.filter(v => v < mean * 0.3).length / (loud.length || 1);
    const sn = getVideoSn();
    meta[sn] = { title: document.title.replace(/\s*線上看.*$/, ''), duration: Math.round(video.duration) };
    (rows[sn] = rows[sn] || []).push([
      s.sec + 1, audioRound(s.db / n, 1), audioRound(gap, 2), audioRound(s.flat / n, 3), Math.round(s.cent / n),
      audioRound(s.low / n, 2), audioRound(s.mid / n, 2), audioRound(s.high / n, 2), audioRound(s.flux / n, 3),
      audioRound(beatScore(), 2), n,
    ]);
  }

  // Normalized autocorrelation of the flux at beat-like lags.
  function beatScore() {
    const frameSec = AUDIO_FRAME_MS / 1000;
    if (flux.length < (AUDIO_BEAT_SEC / frameSec) / 2) return 0;
    const m = flux.reduce((a, b) => a + b, 0) / flux.length;
    const x = flux.map(v => v - m);
    const energy = x.reduce((a, b) => a + b * b, 0);
    if (!energy) return 0;
    let best = 0;
    for (let lag = Math.round(0.25 / frameSec); lag <= Math.round(1.5 / frameSec); lag++) {
      let sum = 0;
      for (let i = lag; i < x.length; i++) sum += x[i] * x[i - lag];
      best = Math.max(best, sum / energy);
    }
    return best;
  }

  async function save() {
    const pending = rows;
    rows = {};
    const sns = Object.keys(pending);
    if (!sns.length) return;
    try {
      const { [AUDIO_STORE]: all = {} } = await chrome.storage.local.get(AUDIO_STORE);
      for (const sn of sns) {
        const entry = all[sn] || { columns: AUDIO_COLUMNS, rows: [] };
        // A second played again (a seek back) replaces the older row.
        const byTime = new Map(entry.rows.map(r => [r[0], r]));
        for (const r of pending[sn]) byTime.set(r[0], r);
        entry.rows = [...byTime.values()].sort((a, b) => a[0] - b[0]);
        Object.assign(entry, meta[sn]);
        entry.at = new Date().toISOString();
        all[sn] = entry;
      }
      const newest = Object.keys(all).sort((a, b) => all[b].at.localeCompare(all[a].at));
      for (const old of newest.slice(AUDIO_MAX_EPISODES)) delete all[old];
      await chrome.storage.local.set({ [AUDIO_STORE]: all });
    } catch (err) {
      log('audioProbeError', { step: 'save', error: String(err) });
    }
  }

  // A new source (ad -> episode, next episode): capture it afresh.
  video.addEventListener('loadedmetadata', () => {
    if (timer) capture();
  });
  window.addEventListener('pagehide', save);
  check();
  return { check };
}

function audioPush(list, value, seconds) {
  list.push(value);
  const max = Math.round(seconds * 1000 / AUDIO_FRAME_MS);
  if (list.length > max) list.splice(0, list.length - max);
}

function audioRound(n, digits) {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}
