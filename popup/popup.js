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

  const { bookmarks = [] } = await chrome.storage.local.get("bookmarks");
  document.getElementById('bookmarkCount').textContent = bookmarks.length ? `(${bookmarks.length})` : '';
  document.getElementById('openBookmarks').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('bookmarks/manager.html') });
    window.close();
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
      delBtn.innerHTML = '&times;';
      delBtn.onclick = () => onRemove(item);
      
      li.appendChild(delBtn);
      container.appendChild(li);
    });
  }
});
