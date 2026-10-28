// popup.js

document.addEventListener('DOMContentLoaded', async () => {
  const aiFilterToggle = document.getElementById('aiFilterToggle');
  const newKeyword = document.getElementById('newKeyword');
  const addKeyword = document.getElementById('addKeyword');
  const keywordList = document.getElementById('keywordList');
  
  const newUser = document.getElementById('newUser');
  const addUser = document.getElementById('addUser');
  const userList = document.getElementById('userList');

  // Load settings
  const storage = await chrome.storage.local.get("settings");
  let settings = storage.settings || {
    aiFilterEnabled: true,
    keywordBlocklist: [],
    userBlocklist: []
  };
  DmkI18n.setLanguage(settings.uiLanguage);
  DmkI18n.apply();

  const uiLanguage = document.getElementById('uiLanguage');
  uiLanguage.value = DmkI18n.language;
  uiLanguage.addEventListener('change', async (e) => {
    settings.uiLanguage = e.target.value;
    DmkI18n.setLanguage(settings.uiLanguage);
    DmkI18n.apply();
    showAgeGateMemory();
    renderList(keywordList, settings.keywordBlocklist, removeKeyword);
    renderList(userList, settings.userBlocklist, removeUser);
    await saveSettings();
  });

  const { bookmarks = [] } = await chrome.storage.local.get("bookmarks");
  document.getElementById('bookmarkCount').textContent = bookmarks.length ? `(${bookmarks.length})` : '';
  document.getElementById('openBookmarks').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('bookmarks/manager.html') });
    window.close();
  });

  // Opens with the work of the current tab already chosen, when it is an episode.
  document.getElementById('openSearch').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let videoSn = null;
    try {
      const url = new URL(tab && tab.url);
      if (url.hostname === 'ani.gamer.com.tw' && url.pathname === '/animeVideo.php') videoSn = url.searchParams.get('sn');
    } catch (_) {}
    const page = chrome.runtime.getURL('search/search.html') + (videoSn ? `?videoSn=${encodeURIComponent(videoSn)}` : '');
    chrome.tabs.create({ url: page });
    window.close();
  });

  const overlayToggle = document.getElementById('overlayToggle');
  overlayToggle.checked = settings.overlayEnabled !== false;
  overlayToggle.addEventListener('change', async (e) => {
    settings.overlayEnabled = e.target.checked;
    await saveSettings();
  });

  const liveToggle = document.getElementById('liveToggle');
  liveToggle.checked = settings.liveUpdate !== false;
  liveToggle.addEventListener('change', async (e) => {
    settings.liveUpdate = e.target.checked;
    await saveSettings();
  });

  const audioProbeToggle = document.getElementById('audioProbeToggle');
  audioProbeToggle.checked = settings.audioProbe === true;
  audioProbeToggle.addEventListener('change', async (e) => {
    settings.audioProbe = e.target.checked;
    await saveSettings();
  });

  const ageGateToggle = document.getElementById('ageGateToggle');
  ageGateToggle.checked = settings.autoAgreeAgeGate !== false;
  ageGateToggle.addEventListener('change', async (e) => {
    settings.autoAgreeAgeGate = e.target.checked;
    await saveSettings();
    showAgeGateMemory();
  });
  document.getElementById('ageGateForget').addEventListener('click', async () => {
    await chrome.storage.local.remove('ageGateConsent');
    showAgeGateMemory();
  });
  showAgeGateMemory();

  // The highest rating agreed to, for the account that agreed most recently
  // (agegate.js keeps one entry per account).
  async function showAgeGateMemory() {
    const levelNames = {
      1: 'popup.level1', 2: 'popup.level2', 3: 'popup.level3', 4: 'popup.level4', 5: 'popup.level5',
    };
    const { ageGateConsent = {} } = await chrome.storage.local.get('ageGateConsent');
    const latest = Object.values(ageGateConsent).sort((a, b) => b.at - a.at)[0];
    document.getElementById('ageGateMemoryText').textContent = latest && levelNames[latest.level]
      ? DmkI18n.t('popup.ageGateRemembered', { level: DmkI18n.t(levelNames[latest.level]) })
      : DmkI18n.t('popup.ageGateNone');
    document.getElementById('ageGateForget').hidden = !latest;
    document.getElementById('ageGateMemory').hidden = !ageGateToggle.checked;
  }

  const densityToggle = document.getElementById('densityToggle');
  densityToggle.checked = settings.densityEnabled !== false;
  densityToggle.addEventListener('change', async (e) => {
    settings.densityEnabled = e.target.checked;
    await saveSettings();
  });

  const debugCount = document.getElementById('debugCount');
  const showDebugCount = async () => {
    const { debugLog = [], opSkipReview = {}, audioProbe = {} } =
      await chrome.storage.local.get(["debugLog", "opSkipReview", "audioProbe"]);
    const review = Object.keys(opSkipReview).length;
    const audio = Object.keys(audioProbe).length;
    debugCount.textContent = `(${debugLog.length}${review ? `, OP ? ${review}` : ''}${audio ? `, audio ${audio}` : ''})`;
  };
  showDebugCount();
  document.getElementById('exportLog').addEventListener('click', async () => {
    // opSkipReview: episodes where opskip.js could not place the OP.
    // audioProbe: per-second audio numbers from audioprobe.js.
    const { debugLog = [], opSkipReview = {}, audioProbe = {} } =
      await chrome.storage.local.get(["debugLog", "opSkipReview", "audioProbe"]);
    const blob = new Blob([JSON.stringify({ debugLog, opSkipReview, audioProbe }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `danmaku-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
  });
  document.getElementById('clearLog').addEventListener('click', async () => {
    await chrome.storage.local.set({ debugLog: [], opSkipReview: {}, audioProbe: {} });
    showDebugCount();
  });

  // Initialize UI
  aiFilterToggle.checked = settings.aiFilterEnabled;
  renderList(keywordList, settings.keywordBlocklist, (val) => removeKeyword(val));
  renderList(userList, settings.userBlocklist, (val) => removeUser(val));

  // Listeners
  aiFilterToggle.addEventListener('change', async (e) => {
    settings.aiFilterEnabled = e.target.checked;
    await saveSettings();
  });

  addKeyword.addEventListener('click', () => {
    const val = newKeyword.value.trim();
    if (val && !settings.keywordBlocklist.includes(val)) {
      settings.keywordBlocklist.push(val);
      newKeyword.value = '';
      saveSettings().then(() => renderList(keywordList, settings.keywordBlocklist, removeKeyword));
    }
  });

  addUser.addEventListener('click', () => {
    const val = newUser.value.trim();
    if (val && !settings.userBlocklist.includes(val)) {
      settings.userBlocklist.push(val);
      newUser.value = '';
      saveSettings().then(() => renderList(userList, settings.userBlocklist, removeUser));
    }
  });

  async function removeKeyword(val) {
    settings.keywordBlocklist = settings.keywordBlocklist.filter(k => k !== val);
    await saveSettings();
    renderList(keywordList, settings.keywordBlocklist, removeKeyword);
  }

  async function removeUser(val) {
    settings.userBlocklist = settings.userBlocklist.filter(u => u !== val);
    await saveSettings();
    renderList(userList, settings.userBlocklist, removeUser);
  }

  async function saveSettings() {
    await chrome.storage.local.set({ settings });
  }

  function renderList(container, items, onRemove) {
    container.innerHTML = '';
    items.forEach(item => {
      const li = document.createElement('li');
      li.textContent = item;
      
      const delBtn = document.createElement('button');
      delBtn.className = 'delete-btn';
      delBtn.textContent = '×';
      delBtn.title = DmkI18n.t('remove');
      delBtn.onclick = () => onRemove(item);
      
      li.appendChild(delBtn);
      container.appendChild(li);
    });
  }
});
