// settings-ui.js
//
// Shared by the popup and the settings page (options.html). Both can be open
// at the same time, and the player's own buttons change settings too, so a
// page never writes back its own old copy: update() reads the stored
// settings again, changes only what it was asked to, and writes them back.
// Writes from one page run one after another. Changes from anywhere reach
// every page through storage.onChanged, and bindToggle() keeps its checkbox
// in step with them.

const DmkSettings = (() => {
  let current = {};
  let queue = Promise.resolve();
  const listeners = [];

  async function load() {
    const { settings } = await chrome.storage.local.get('settings');
    current = settings || {};
    return current;
  }

  // change(settings) edits a fresh copy of the stored settings in place.
  function update(change) {
    queue = queue.then(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      const next = { ...(settings || {}) };
      change(next);
      current = next;
      await chrome.storage.local.set({ settings: next });
    }).catch(err => console.error('[Danmaku Enhancer] settings', err));
    return queue;
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    // Not `current`: update() has already set it to this page's own change.
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
    el.addEventListener('change', () => update(s => { s[key] = el.checked; }));
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
