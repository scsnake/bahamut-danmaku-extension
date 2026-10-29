// density.js
//
// A faint curve of danmaku density over the whole episode, drawn just above
// the progress bar so busy scenes show before you reach them. It lives inside
// the player's `.vjs-progress-holder`, so it spans exactly the timeline and
// fades out with the control bar. In info mode, getDanmaku() gives only the
// informative comments (infomode.js). content.js calls initDensityCurve() once
// the player exists and update() whenever the list, the filters or the
// duration change. getMarks() (optional) gives the OP's { start, end } in
// seconds, drawn as a pair of small triangles, ◣ at the start and ◢ at the
// end (opskip.js).

const DENSITY_BINS = 240;
const DENSITY_HEIGHT = 24;  // viewBox units; the CSS sets the pixel height
// Shorter videos are pre-roll ads (they play in the same <video>).
const DENSITY_MIN_SEC = 60;
const DENSITY_KERNEL = [1, 4, 6, 4, 1];

function initDensityCurve({ video, player, getDanmaku, isEnabled, getMarks = () => null }) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const root = document.createElement('div');
  root.className = 'dmk-density';
  root.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('dmk-density-curve');
  svg.setAttribute('viewBox', `0 0 ${DENSITY_BINS} ${DENSITY_HEIGHT}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const area = document.createElementNS(SVG_NS, 'path');
  area.classList.add('dmk-density-area');
  const line = document.createElementNS(SVG_NS, 'path');
  line.classList.add('dmk-density-line');
  svg.append(area, line);
  // HTML, not SVG: the curve stretches with the timeline, the marks keep
  // their size.
  const startMark = document.createElement('div');
  startMark.className = 'dmk-op-mark dmk-op-mark-start';
  const endMark = document.createElement('div');
  endMark.className = 'dmk-op-mark dmk-op-mark-end';
  root.append(svg, startMark, endMark);

  let pending = 0;

  // Batches calls that come together (a reload right after a settings
  // change, for example) into one redraw.
  function update() {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(draw);
  }

  function draw() {
    const holder = player.querySelector('.vjs-progress-holder');
    const duration = video.duration;
    const show = isEnabled() && holder &&
      Number.isFinite(duration) && duration >= DENSITY_MIN_SEC &&
      !player.classList.contains('vjs-ad-playing');
    if (!show) {
      root.remove();
      return;
    }
    // Square-root scale, so quieter scenes still show next to the peaks.
    const values = smooth(countBins(getDanmaku(), duration)).map(Math.sqrt);
    const max = Math.max(...values);
    const range = getMarks();
    // No comments (for example an episode with no informative ones): no
    // curve, but the OP marks still show.
    if (!max && !range) {
      root.remove();
      return;
    }
    if (max) {
      // One point per bin center (x = i + 0.5); the first and last values
      // are carried out to both ends of the timeline.
      const ys = values.map(v => round(DENSITY_HEIGHT * (1 - v / max)));
      const points = ys.map((y, i) => `${i + 0.5},${y}`);
      const top = `M0,${ys[0]} L${points.join(' L')} L${DENSITY_BINS},${ys[ys.length - 1]}`;
      line.setAttribute('d', top);
      area.setAttribute('d', `${top} L${DENSITY_BINS},${DENSITY_HEIGHT} L0,${DENSITY_HEIGHT} Z`);
    } else {
      line.setAttribute('d', '');
      area.setAttribute('d', '');
    }
    placeMark(startMark, range && range.start, duration);
    placeMark(endMark, range && range.end, duration);
    if (root.parentNode !== holder) holder.appendChild(root);
  }

  function placeMark(mark, sec, duration) {
    mark.hidden = !Number.isFinite(sec);
    if (!mark.hidden) mark.style.left = `${round(100 * Math.min(Math.max(sec / duration, 0), 1))}%`;
  }

  // Counts the comments the viewer would see (not blocked) per time bin.
  function countBins(list, duration) {
    const bins = new Array(DENSITY_BINS).fill(0);
    const tenthsPerBin = duration * 10 / DENSITY_BINS;
    for (const d of list) {
      if (d.isBlocked) continue;
      const i = Math.floor(d.time / tenthsPerBin);
      if (i >= 0 && i < DENSITY_BINS) bins[i]++;
    }
    return bins;
  }

  function smooth(bins) {
    const half = (DENSITY_KERNEL.length - 1) / 2;
    return bins.map((_, i) => {
      let sum = 0;
      let weight = 0;
      DENSITY_KERNEL.forEach((k, j) => {
        const v = bins[i + j - half];
        if (v === undefined) return;
        sum += k * v;
        weight += k;
      });
      return sum / weight;
    });
  }

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  video.addEventListener('durationchange', update);
  video.addEventListener('loadedmetadata', update);
  // The ad class can change without a duration change. The player's class
  // changes often (idle mouse, pause, buffering), so redraw only on the ad.
  let adPlaying = player.classList.contains('vjs-ad-playing');
  new MutationObserver(() => {
    const now = player.classList.contains('vjs-ad-playing');
    if (now === adPlaying) return;
    adPlaying = now;
    update();
  }).observe(player, { attributes: true, attributeFilter: ['class'] });

  return { update };
}
