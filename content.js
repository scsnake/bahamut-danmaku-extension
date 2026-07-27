// content.js

let videoElement = null;
let overlayElement = null;
let danmakuData = [];
let activeDanmaku = new Map(); // sn -> DOM element
let settings = {};

// We will fetch webpage blocklist here
let webpageBlocklist = [];

// Initialize
async function init() {
  console.log("[Danmaku Enhancer] Initializing...");
  
  // Extract videoSn from URL
  const urlParams = new URLSearchParams(window.location.search);
  const videoSn = urlParams.get('sn');
  if (!videoSn) {
    console.log("[Danmaku Enhancer] No videoSn found in URL.");
    return;
  }

  // Load extension settings
  const storage = await chrome.storage.local.get("settings");
  settings = storage.settings || { aiFilterEnabled: true, keywordBlocklist: [], userBlocklist: [] };

  // Try to extract webpage blocklist (usually in localStorage)
  extractWebpageBlocklist();

  // Wait for the video element to be ready
  videoElement = await waitForElement('#ani_video_html5_api');
  const videoContainer = await waitForElement('#ani_video');

  // Inject overlay
  overlayElement = document.createElement('div');
  overlayElement.id = 'custom_danmu_overlay';
  videoContainer.appendChild(overlayElement);

  // Fetch Danmaku data from background
  console.log(`[Danmaku Enhancer] Fetching danmaku for videoSn: ${videoSn}`);
  chrome.runtime.sendMessage({ type: 'FETCH_DANMAKU', videoSn }, (response) => {
    if (response && response.success && response.data && response.data.data) {
      danmakuData = response.data.data.danmu || [];
      console.log(`[Danmaku Enhancer] Loaded ${danmakuData.length} danmaku items. (Bypassed 3000 limit)`);
      processDanmaku();
    } else {
      console.error("[Danmaku Enhancer] Failed to fetch danmaku", response?.error);
    }
  });

  // Attach video events
  videoElement.addEventListener('timeupdate', onTimeUpdate);
  videoElement.addEventListener('seeked', onSeeked);
}

// Extract the webpage's built-in blocklist from localStorage
function extractWebpageBlocklist() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      // Bahamut often stores filter in keys like 'anime_filter_words' or similar
      if (key && key.toLowerCase().includes('filter')) {
        const val = localStorage.getItem(key);
        try {
          const parsed = JSON.parse(val);
          if (Array.isArray(parsed)) {
            webpageBlocklist = [...new Set([...webpageBlocklist, ...parsed])];
          }
        } catch (e) {
          // might be comma separated string
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

// Basic fast filter: checks keywords, user blocklist, and webpage blocklist
function passesBasicFilter(danmaku) {
  const text = danmaku.text;
  const userid = danmaku.userid;

  if (settings.userBlocklist && settings.userBlocklist.includes(userid)) return false;
  
  const allKeywords = [...(settings.keywordBlocklist || []), ...webpageBlocklist];
  for (const kw of allKeywords) {
    if (text.includes(kw)) return false;
  }
  return true;
}

// Prepare danmaku data
function processDanmaku() {
  // Sort by time (time is in 100ms units, e.g., 250 = 25.0 seconds)
  danmakuData.sort((a, b) => a.time - b.time);
  
  // Apply Pass 1 filter to all
  danmakuData.forEach(d => {
    d.isBlocked = !passesBasicFilter(d);
    d.aiEvaluated = false; // Flag for Pass 2 (lazy evaluation)
    d.rendered = false;
  });
}

// Render loop
let lastTime = 0;
async function onTimeUpdate() {
  if (!videoElement) return;
  const currentTime = videoElement.currentTime; // in seconds
  
  // Determine bounds (fetch comments that should start showing in the next 1 second)
  // Danmaku time is in tenths of a second (currentTime * 10)
  const currentTenths = currentTime * 10;
  const lookaheadTenths = currentTenths + 10; // 1 second lookahead
  
  // Find danmaku to render
  const toRender = danmakuData.filter(d => 
    !d.isBlocked && 
    !d.rendered && 
    d.time >= currentTenths && 
    d.time <= lookaheadTenths
  );

  // Lazy AI Filtering (Batching)
  if (settings.aiFilterEnabled && toRender.length > 0) {
    const unevaluated = toRender.filter(d => !d.aiEvaluated);
    if (unevaluated.length > 0) {
      // Send to background for AI evaluation
      // We don't await here to not block the main thread, we just mark them as evaluated
      unevaluated.forEach(d => d.aiEvaluated = 'pending');
      
      chrome.runtime.sendMessage({ type: 'AI_FILTER_BATCH', batch: unevaluated }, (res) => {
        if (res && res.success) {
          res.results.forEach(r => {
            const d = danmakuData.find(x => x.sn === r.sn);
            if (d) {
              d.aiEvaluated = true;
              if (!r.allowed) d.isBlocked = true;
            }
          });
        }
      });
    }
  }

  // Render safe danmaku
  toRender.forEach(d => {
    if (!d.isBlocked && d.aiEvaluated !== 'pending') {
      renderDanmaku(d);
      d.rendered = true;
    }
  });
}

function onSeeked() {
  // Clear overlay and reset rendered state
  overlayElement.innerHTML = '';
  activeDanmaku.clear();
  const currentTenths = videoElement.currentTime * 10;
  
  danmakuData.forEach(d => {
    if (d.time < currentTenths) d.rendered = true;
    else d.rendered = false;
  });
}

// Track rows to prevent overlaps (simple implementation)
const rows = new Array(15).fill(0); // 15 rows max

function renderDanmaku(d) {
  const el = document.createElement('div');
  el.className = 'custom-danmaku-item';
  el.textContent = d.text;
  
  // Styling based on data (color, size)
  el.style.color = d.color || '#ffffff';
  el.style.fontSize = d.size === 0 ? '18px' : (d.size === 1 ? '24px' : '32px'); // Example sizes
  
  // Find a free row
  const now = Date.now();
  let rowIndex = 0;
  for (let i = 0; i < rows.length; i++) {
    if (now > rows[i]) {
      rowIndex = i;
      // Lock row for roughly 2 seconds (estimated time to clear right edge)
      rows[i] = now + 2000; 
      break;
    }
  }
  
  const topPos = rowIndex * 30; // 30px per row
  el.style.top = `${topPos}px`;
  
  // Handle position types: 0 = rolling, 1 = bottom static, 2 = top static
  // For simplicity, we just implement rolling here
  el.style.left = '100%';
  el.style.transform = 'translateX(0)';
  
  // Animation settings
  const duration = 6000; // 6 seconds to cross screen
  el.style.transition = `transform ${duration}ms linear`;
  
  overlayElement.appendChild(el);
  
  // Trigger animation next frame
  requestAnimationFrame(() => {
    // We translate by calc(-100vw - 100%) to fully clear the screen left side
    el.style.transform = 'translateX(calc(-100vw - 100%))';
  });

  // Add click listener to show modal
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    videoElement.pause();
    showDanmakuModal(d);
  });

  // Cleanup after animation
  setTimeout(() => {
    if (overlayElement.contains(el)) {
      overlayElement.removeChild(el);
    }
  }, duration);
}

// Utility: Wait for element to exist
function waitForElement(selector) {
  return new Promise(resolve => {
    if (document.querySelector(selector)) {
      return resolve(document.querySelector(selector));
    }
    const observer = new MutationObserver(mutations => {
      if (document.querySelector(selector)) {
        observer.disconnect();
        resolve(document.querySelector(selector));
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

init();

// Modal UI for clicked danmaku
function showDanmakuModal(d) {
  let existingModal = document.getElementById('danmaku-info-modal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.id = 'danmaku-info-modal';

  const totalSeconds = Math.floor(d.time / 10);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  const timeStr = `${minutes}:${seconds}`;

  modal.innerHTML = `
    <div class="modal-header">
      <span class="modal-title">Danmaku Info</span>
      <span class="modal-time">${timeStr}</span>
    </div>
    <div class="modal-content">${d.text}</div>
    <div class="modal-meta">Author ID: ${d.userid}</div>
    <div class="modal-actions">
      <button class="btn-copy">Copy</button>
      <button class="btn-danger btn-block-user">Block User</button>
      <button class="btn-danger btn-filter-text">Filter Text</button>
      <button class="btn-secondary btn-close">Close</button>
    </div>
  `;

  // Stop clicks in modal from pausing video if it leaks
  modal.addEventListener('click', (e) => e.stopPropagation());

  overlayElement.appendChild(modal);

  modal.querySelector('.btn-close').onclick = () => {
    modal.remove();
    videoElement.play();
  };

  modal.querySelector('.btn-copy').onclick = () => {
    navigator.clipboard.writeText(d.text);
    modal.querySelector('.btn-copy').textContent = 'Copied!';
  };

  modal.querySelector('.btn-block-user').onclick = async () => {
    if (!settings.userBlocklist.includes(d.userid)) {
      settings.userBlocklist.push(d.userid);
      await chrome.storage.local.set({ settings });
    }
    modal.remove();
    processDanmaku();
    onSeeked(); // Trigger a re-render to clear blocked danmaku
    videoElement.play();
  };

  modal.querySelector('.btn-filter-text').onclick = async () => {
    if (!settings.keywordBlocklist.includes(d.text)) {
      settings.keywordBlocklist.push(d.text);
      await chrome.storage.local.set({ settings });
    }
    modal.remove();
    processDanmaku();
    onSeeked(); // Trigger a re-render
    videoElement.play();
  };
}
