// options.js
//
// The settings page (chrome://extensions → Details → Extension options, a
// right-click on the toolbar icon, or "All settings" in the popup). It has
// every setting: the switches used while watching (also in the popup), and
// the ones set once or edited here: language, OP audio match, age gate,
// filter lists, OP report consent and the debug tools.

document.addEventListener('DOMContentLoaded', async () => {
  await DmkSettings.load();
  const keywordList = document.getElementById('keywordList');
  const userList = document.getElementById('userList');

  DmkSettings.bindToggle('overlayToggle', 'overlayEnabled', true);
  DmkSettings.bindToggle('liveToggle', 'liveUpdate', true);
  DmkSettings.bindToggle('infoModeToggle', 'infoMode', false);
  DmkSettings.bindToggle('densityToggle', 'densityEnabled', true);
  DmkSettings.bindToggle('opSkipToggle', 'opSkipEnabled', true);
  DmkSettings.bindToggle('opAudioToggle', 'opAudio', true);
  DmkSettings.bindToggle('aiFilterToggle', 'aiFilterEnabled', false);
  DmkSettings.bindToggle('debugModeToggle', 'debugMode', false);
  DmkSettings.bindToggle('audioProbeToggle', 'audioProbe', false);

  const uiLanguage = document.getElementById('uiLanguage');
  uiLanguage.addEventListener('change', () => {
    DmkSettings.update({ set: { uiLanguage: uiLanguage.value } });
  });

  // --- Age gate ---------------------------------------------------------------

  const ageGateToggle = DmkSettings.bindToggle('ageGateToggle', 'autoAgreeAgeGate', true);
  ageGateToggle.addEventListener('change', showAgeGateMemory);
  DmkSettings.onChange(showAgeGateMemory);
  document.getElementById('ageGateForget').addEventListener('click', async () => {
    await chrome.storage.local.remove('ageGateConsent');
  });

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

  // --- Filter lists -----------------------------------------------------------

  bindList('keywordForm', 'newKeyword', 'keywordBlocklist');
  bindList('userForm', 'newUser', 'userBlocklist');
  DmkSettings.onChange((s, prev) => {
    if (s.keywordBlocklist !== prev.keywordBlocklist || s.userBlocklist !== prev.userBlocklist) renderLists();
  });

  function bindList(formId, inputId, key) {
    const input = document.getElementById(inputId);
    document.getElementById(formId).addEventListener('submit', (e) => {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;
      input.value = '';
      DmkSettings.update({ add: { [key]: val } });
    });
  }

  function renderLists() {
    const s = DmkSettings.get();
    renderList(keywordList, s.keywordBlocklist || [], 'keywordBlocklist');
    renderList(userList, s.userBlocklist || [], 'userBlocklist');
  }

  function renderList(container, items, key) {
    container.replaceChildren();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = DmkI18n.t('options.empty');
      container.appendChild(li);
      return;
    }
    items.forEach(item => {
      const li = document.createElement('li');
      li.textContent = item;

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'delete-btn';
      delBtn.textContent = '×';
      delBtn.title = DmkI18n.t('remove');
      delBtn.onclick = () => {
        DmkSettings.update({ remove: { [key]: item } });
      };

      li.appendChild(delBtn);
      container.appendChild(li);
    });
  }

  // --- OP reports -------------------------------------------------------------

  // Shown only when reporting is set up in background.js.
  chrome.runtime.sendMessage({ type: 'OP_REPORT_READY' }).then((res) => {
    document.getElementById('opReportSection').hidden = !(res && res.ready);
  }).catch(() => {});
  const showConsent = async () => {
    const { opReportConsent } = await chrome.storage.local.get('opReportConsent');
    document.getElementById('opReportAgreed').hidden = opReportConsent !== true;
    document.getElementById('opReportNotAgreed').hidden = opReportConsent === true;
  };
  showConsent();
  document.getElementById('opReportWithdraw').addEventListener('click', async () => {
    await chrome.storage.local.remove('opReportConsent');
  });

  // --- Debug ------------------------------------------------------------------

  const debugCount = document.getElementById('debugCount');
  const showDebugCount = async () => {
    const { debugLog = [], opSkipReview = {}, audioProbe = {} } =
      await chrome.storage.local.get(["debugLog", "opSkipReview", "audioProbe"]);
    const review = Object.keys(opSkipReview).length;
    const audio = Object.keys(audioProbe).length;
    debugCount.textContent = `(${debugLog.length}${review ? `, OP ? ${review}` : ''}${audio ? `, audio ${audio}` : ''})`;
  };
  showDebugCount();
  // The log grows while a video plays in another tab.
  window.addEventListener('focus', showDebugCount);
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

  // Changes made elsewhere: the player remembers a rating or asks for report
  // consent while this page is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ageGateConsent) showAgeGateMemory();
    if (changes.opReportConsent) showConsent();
  });

  document.getElementById('openPrivacy').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('privacy/privacy.html') });
  });

  // Last, when everything above exists: the text, and again whenever the
  // language changes (here or in another tab).
  DmkSettings.applyLanguage(() => {
    uiLanguage.value = DmkI18n.language;
    document.title = `${DmkI18n.t('options.title')} – ${DmkI18n.t('appName')}`;
    document.getElementById('version').textContent =
      DmkI18n.t('options.version', { version: chrome.runtime.getManifest().version });
    renderLists();
    showAgeGateMemory();
  });
});
