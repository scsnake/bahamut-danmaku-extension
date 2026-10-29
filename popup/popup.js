// popup.js
//
// The switches used while watching, and links to the bookmark manager, the
// search page and the settings page (options/options.html), which has every
// setting.

document.addEventListener('DOMContentLoaded', async () => {
  await DmkSettings.load();
  DmkSettings.applyLanguage();

  DmkSettings.bindToggle('overlayToggle', 'overlayEnabled', true);
  DmkSettings.bindToggle('liveToggle', 'liveUpdate', true);
  DmkSettings.bindToggle('infoModeToggle', 'infoMode', false);
  DmkSettings.bindToggle('densityToggle', 'densityEnabled', true);

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

  // One-click wrong-OP report for the current episode tab (opreport.js;
  // the tab asks for consent the first time). Shown only when reporting is
  // set up in background.js.
  chrome.runtime.sendMessage({ type: 'OP_REPORT_READY' }).then((res) => {
    document.getElementById('opReportRow').hidden = !(res && res.ready);
  }).catch(() => {});
  document.getElementById('opReport').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'OP_REPORT_OPEN' });
      window.close();
    } catch (_) {
      // No content script there: not an episode page.
      document.getElementById('opReportNote').hidden = false;
    }
  });

  document.getElementById('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
});
