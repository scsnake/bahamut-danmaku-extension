// content.js

let videoElement = null;
let overlayElement = null;
let danmakuData = [];
let settings = {};
let webpageBlocklist = [];

// All in-flight rolling-danmaku animations. Paused/resumed with the video,
// cancelled on seek.
const activeAnimations = new Set();

const ROW_COUNT = 15;
const ROW_HEIGHT = 34;
const DANMAKU_DURATION_MS = 6000;
// rowFreeAt[i] = video time (seconds) at which row i can accept a new comment.
const rowFreeAt = new Array(ROW_COUNT).fill(0);

async function init() {
  console.log("[Danmaku Enhancer] Initializing...");

  const urlParams = new URLSearchParams(window.location.search);
  const videoSn = urlParams.get('sn');
  if (!videoSn) {
    console.log("[Danmaku Enhancer] No videoSn found in URL.");
    return;
  }

  const storage = await chrome.storage.local.get("settings");
  settings = storage.settings || {
    aiFilterEnabled: true,
    aiStrictness: 'moderate',
    keywordBlocklist: [],
    userBlocklist: []
  };

  extractWebpageBlocklist();

  try {
    videoElement = await waitForElement('#ani_video_html5_api');
  } catch (err) {
    console.error("[Danmaku Enhancer] Video element not found:", err);
    return;
  }
  const videoContainer = await waitForElement('#ani_video');

  overlayElement = document.createElement('div');
  overlayElement.id = 'custom_danmu_overlay';
  videoContainer.appendChild(overlayElement);

  initBookmarks({
    video: videoElement,
    container: videoContainer,
    videoSn,
    getDanmaku: () => danmakuData,
  });

  console.log(`[Danmaku Enhancer] Fetching danmaku for videoSn: ${videoSn}`);
  chrome.runtime.sendMessage({ type: 'FETCH_DANMAKU', videoSn }, (response) => {
    if (response && response.success && response.data) {
      // API response shape may be {data: {danmu: [...]}} or {data: [...]}
      const payload = response.data.data;
      if (Array.isArray(payload)) {
        danmakuData = payload;
      } else if (payload && Array.isArray(payload.danmu)) {
        danmakuData = payload.danmu;
      } else {
        danmakuData = [];
      }
      console.log(`[Danmaku Enhancer] Loaded ${danmakuData.length} danmaku items. (Bypassed 3000 limit)`);
      processDanmaku();
    } else {
      console.error("[Danmaku Enhancer] Failed to fetch danmaku", response?.error);
    }
  });

  videoElement.addEventListener('timeupdate', onTimeUpdate);
  videoElement.addEventListener('seeked', onSeeked);
  videoElement.addEventListener('pause', pauseAllAnimations);
  videoElement.addEventListener('play', resumeAllAnimations);
  videoElement.addEventListener('waiting', pauseAllAnimations);
  videoElement.addEventListener('playing', resumeAllAnimations);
}

function extractWebpageBlocklist() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      // TODO(verify): confirm the exact Bahamut localStorage key name for
      // user-configured filter words. Broad "includes('filter')" match may
      // pick up unrelated third-party keys.
      if (key && key.toLowerCase().includes('filter')) {
        const val = localStorage.getItem(key);
        try {
          const parsed = JSON.parse(val);
          if (Array.isArray(parsed)) {
            webpageBlocklist = [...new Set([...webpageBlocklist, ...parsed])];
          }
        } catch (e) {
          if (typeof val === 'string' && val.includes(',')) {
            webpageBlocklist = [...new Set([...webpageBlocklist, ...val.split(',')])];
          }
        }
      }
    }
    console.log("[Danmaku Enhancer] Extracted webpage blocklist:", webpageBlocklist);
  } catch (err) {
    console.error("[Danmaku Enhancer] Could not extract webpage blocklist", err);
  }
}

function passesBasicFilter(danmaku) {
  const text = danmaku.text || '';
  const userid = danmaku.userid;

  if (settings.userBlocklist && settings.userBlocklist.includes(userid)) return false;

  const allKeywords = [...(settings.keywordBlocklist || []), ...webpageBlocklist];
  for (const kw of allKeywords) {
    if (kw && text.includes(kw)) return false;
  }
  return true;
}

function processDanmaku() {
  danmakuData.sort((a, b) => a.time - b.time);
  danmakuData.forEach(d => {
    d.isBlocked = !passesBasicFilter(d);
    d.aiEvaluated = false;
    d.rendered = false;
  });
}

async function onTimeUpdate() {
  if (!videoElement || !danmakuData.length) return;

  const currentTime = videoElement.currentTime;
  const currentTenths = currentTime * 10;
  const lookaheadTenths = currentTenths + 20; // 2s lookahead for AI batching
  const graceTenths = 30; // 3s grace before we give up on late items

  // Fire off AI evaluation for imminent items.
  if (settings.aiFilterEnabled) {
    const toEvaluate = danmakuData.filter(d =>
      !d.isBlocked && !d.rendered && !d.aiEvaluated &&
      d.time <= lookaheadTenths &&
      d.time >= currentTenths - graceTenths
    );
    if (toEvaluate.length > 0) {
      toEvaluate.forEach(d => { d.aiEvaluated = 'pending'; });
      const batch = toEvaluate.map(d => ({ sn: d.sn, text: d.text }));
      chrome.runtime.sendMessage({ type: 'AI_FILTER_BATCH', batch }, (res) => {
        if (res && res.success) {
          res.results.forEach(r => {
            const d = danmakuData.find(x => x.sn === r.sn);
            if (d && d.aiEvaluated === 'pending') {
              d.aiEvaluated = true;
              if (!r.allowed) d.isBlocked = true;
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
  }

  // Render items whose scheduled time has arrived and which have cleared AI.
  danmakuData.forEach(d => {
    if (d.isBlocked || d.rendered) return;
    if (d.time > currentTenths) return;
    if (d.time < currentTenths - graceTenths) {
      // Missed the window (probably AI never came back). Drop silently.
      d.rendered = true;
      return;
    }
    if (settings.aiFilterEnabled && d.aiEvaluated !== true) return;
    renderDanmaku(d, currentTime);
    d.rendered = true;
  });
}

function onSeeked() {
  if (!overlayElement) return;
  overlayElement.innerHTML = '';
  activeAnimations.forEach(a => { try { a.cancel(); } catch (_) {} });
  activeAnimations.clear();
  rowFreeAt.fill(0);

  const currentTenths = videoElement.currentTime * 10;
  danmakuData.forEach(d => {
    // Stale in-flight AI results should be ignored; re-evaluate on demand.
    if (d.aiEvaluated === 'pending') d.aiEvaluated = false;
    d.rendered = d.time < currentTenths;
  });
}

function pauseAllAnimations() {
  activeAnimations.forEach(a => { try { a.pause(); } catch (_) {} });
}

function resumeAllAnimations() {
  activeAnimations.forEach(a => { try { a.play(); } catch (_) {} });
}

function findFreeRow(currentVideoTime) {
  for (let i = 0; i < ROW_COUNT; i++) {
    if (currentVideoTime >= rowFreeAt[i]) return i;
  }
  return -1;
}

function renderDanmaku(d, currentVideoTime) {
  // TODO(verify): treat all comments as rolling for now. Confirm the field
  // name/values for position type (top/bottom static) in the API response.
  const rowIndex = findFreeRow(currentVideoTime);
  if (rowIndex < 0) return; // No free row: drop rather than stack on row 0.

  const el = document.createElement('div');
  el.className = 'custom-danmaku-item';
  el.textContent = d.text; // textContent, never innerHTML — prevents XSS.

  const fontSize = d.size === 0 ? 18 : (d.size === 1 ? 24 : 32);
  
  // Convert integer color to hex if needed
  let colorStr = '#ffffff';
  if (d.color !== undefined) {
    if (typeof d.color === 'number') {
      colorStr = '#' + d.color.toString(16).padStart(6, '0');
    } else {
      colorStr = d.color;
    }
  }
  el.style.color = colorStr;
  el.style.fontSize = `${fontSize}px`;
  el.style.top = `${rowIndex * ROW_HEIGHT}px`;
  el.style.left = '100%';

  overlayElement.appendChild(el);

  // Measure now that the element is in the DOM; use it to compute a precise
  // row lock (row is free once trailing edge clears the right side).
  const textWidth = el.offsetWidth;
  const containerWidth = overlayElement.offsetWidth || window.innerWidth;
  const durationSec = DANMAKU_DURATION_MS / 1000;
  const lockSec = durationSec * textWidth / (containerWidth + textWidth) + 0.2;
  rowFreeAt[rowIndex] = currentVideoTime + lockSec;

  const anim = el.animate(
    [
      { transform: 'translateX(0)' },
      { transform: `translateX(calc(-${containerWidth}px - 100%))` }
    ],
    { duration: DANMAKU_DURATION_MS, easing: 'linear', fill: 'forwards' }
  );
  activeAnimations.add(anim);

  // If the video was already paused when this comment was scheduled, hold it.
  if (videoElement.paused) anim.pause();

  const cleanup = () => {
    activeAnimations.delete(anim);
    if (overlayElement.contains(el)) overlayElement.removeChild(el);
  };
  anim.onfinish = cleanup;
  anim.oncancel = cleanup;

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    videoElement.pause();
    showDanmakuModal(d);
  });
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
    onSeeked();
    videoElement.play();
  };

  filterTextBtn.onclick = async () => {
    if (!settings.keywordBlocklist.includes(d.text)) {
      settings.keywordBlocklist.push(d.text);
      await chrome.storage.local.set({ settings });
    }
    modal.remove();
    processDanmaku();
    onSeeked();
    videoElement.play();
  };
}
