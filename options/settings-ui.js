// settings-ui.js
//
// Shared by the popup and the settings page (options.html). Both can be open
// at the same time, and the player's own buttons change settings too, so a
// page never writes its own copy: update() sends only the change to
// background.js (SETTINGS_UPDATE), the one writer, which applies changes
// one after another. Changes from anywhere reach every page through
// storage.onChanged, and bindToggle() keeps its checkbox in step with them.

const DmkSettings = (() => {
  let current = {};
  const listeners = [];

  async function load() {
    const { settings } = await chrome.storage.local.get('settings');
    current = settings || {};
    return current;
  }

  // change: { set: { key: value }, add: { listKey: item }, remove: { listKey: item } }.
  async function update(change) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATE', change });
      if (!res || !res.ok) throw new Error((res && res.error) || 'no reply');
    } catch (err) {
      console.error('[Danmaku Enhancer] settings', err);
    }
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const prev = changes.settings.oldValue || {};
    current = changes.settings.newValue || {};
    listeners.forEach(fn => fn(current, prev));
  });

  // A checkbox for one boolean setting. `onByDefault`: an unset setting
  // counts as on (stored false turns it off) instead of off.
  function bindToggle(id, key, onByDefault) {
    const el = document.getElementById(id);
    const read = s => (onByDefault ? s[key] !== false : s[key] === true);
    el.checked = read(current);
    el.addEventListener('change', () => update({ set: { [key]: el.checked } }));
    onChange(s => { el.checked = read(s); });
    return el;
  }

  // Applies the interface language (after load(), and whenever it changes).
  function applyLanguage(onApplied) {
    const apply = () => {
      DmkI18n.setLanguage(current.uiLanguage);
      DmkI18n.apply();
      if (onApplied) onApplied();
    };
    apply();
    onChange((s, prev) => { if (s.uiLanguage !== prev.uiLanguage) apply(); });
  }

  return { get: () => current, load, update, onChange, bindToggle, applyLanguage };
})();
