// bookmarks/store.js — loaded into the background service worker.
//
// Sole writer for scene bookmarks. The content script and the manager page
// both send BOOKMARK_* messages here; funnelling every write through one
// queue keeps their read-modify-write cycles from dropping each other's edits.

const BOOKMARK_MAX_THUMB_LENGTH = 400 * 1024;
const BOOKMARK_MAX_SNIPPET = 30;

let bookmarkWriteQueue = Promise.resolve();

// `fn` receives the current list and returns
// { bookmarks, result, set?, remove? } — the new list, the value to hand back
// to the caller, and any extra storage keys to write or delete alongside it.
function mutateBookmarks(fn) {
  const run = bookmarkWriteQueue.then(async () => {
    const { bookmarks: current = [] } = await chrome.storage.local.get('bookmarks');
    const { bookmarks, result, set = {}, remove = [] } = await fn(current);
    await chrome.storage.local.set({ ...set, bookmarks });
    if (remove.length) await chrome.storage.local.remove(remove);
    return result;
  });
  bookmarkWriteQueue = run.catch(() => {});
  return run;
}

function cleanText(v, max) {
  return v == null ? '' : String(v).trim().slice(0, max);
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,，、]/);
  const cleaned = list.map(t => cleanText(t, 40).replace(/^#+/, '').trim()).filter(Boolean);
  return [...new Set(cleaned)].slice(0, 20);
}

// Covers come from the page's og:image (p2.bahamut.com.tw). Other hosts are
// dropped, so an imported file cannot make the manager load images from
// any server.
function isBahamutImage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(bahamut|gamer)\.com\.tw$/.test(u.hostname);
  } catch (_) {
    return false;
  }
}

// Everything that reaches storage passes through here, including imported
// files, so treat input as untrusted and return null when it's unusable.
function sanitizeBookmark(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanText(raw.id, 64);
  const videoSn = cleanText(raw.videoSn, 20);
  const start = Number(raw.start);
  if (!/^[\w-]+$/.test(id) || !/^\d+$/.test(videoSn) || !Number.isFinite(start) || start < 0) {
    return null;
  }
  let end = raw.end == null || raw.end === '' ? null : Number(raw.end);
  if (!Number.isFinite(end) || end <= start) end = null;

  const coverUrl = cleanText(raw.coverUrl, 1000);
  const animeSn = cleanText(raw.animeSn, 20);
  const now = Date.now();
  const time = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : now);

  return {
    id,
    videoSn,
    animeSn: /^\d+$/.test(animeSn) ? animeSn : null,
    animeTitle: cleanText(raw.animeTitle, 200),
    episodeTitle: cleanText(raw.episodeTitle, 200),
    episode: cleanText(raw.episode, 40),
    start: DmkBookmarks.round1(start),
    end: end == null ? null : DmkBookmarks.round1(end),
    title: cleanText(raw.title, 200),
    note: cleanText(raw.note, 5000),
    tags: normalizeTags(raw.tags),
    coverUrl: isBahamutImage(coverUrl) ? coverUrl : '',
    danmaku: (Array.isArray(raw.danmaku) ? raw.danmaku : [])
      .slice(0, BOOKMARK_MAX_SNIPPET)
      .map(d => ({ time: DmkBookmarks.round1(Number(d && d.time) || 0), text: cleanText(d && d.text, 200) }))
      .filter(d => d.text),
    createdAt: time(raw.createdAt),
    updatedAt: time(raw.updatedAt),
  };
}

function isValidThumb(v) {
  return typeof v === 'string' &&
    v.length <= BOOKMARK_MAX_THUMB_LENGTH &&
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v);
}

const bookmarkHandlers = {
  async BOOKMARK_ADD({ bookmark, thumb }) {
    const now = Date.now();
    const b = sanitizeBookmark({ ...bookmark, createdAt: now, updatedAt: now });
    if (!b) throw new Error('Invalid bookmark');
    return mutateBookmarks(list => ({
      bookmarks: [...list.filter(x => x.id !== b.id), b],
      set: isValidThumb(thumb) ? { [DmkBookmarks.THUMB_PREFIX + b.id]: thumb } : {},
      result: { bookmark: b },
    }));
  },

  async BOOKMARK_UPDATE({ id, patch }) {
    return mutateBookmarks(list => {
      const idx = list.findIndex(x => x.id === id);
      if (idx < 0) throw new Error('Bookmark not found');
      const allowed = {};
      for (const key of ['title', 'note', 'tags', 'start', 'end']) {
        if (patch && key in patch) allowed[key] = patch[key];
      }
      const next = sanitizeBookmark({ ...list[idx], ...allowed, updatedAt: Date.now() });
      if (!next) throw new Error('Invalid bookmark');
      const bookmarks = list.slice();
      bookmarks[idx] = next;
      return { bookmarks, result: { bookmark: next } };
    });
  },

  async BOOKMARK_DELETE({ ids }) {
    const drop = new Set(Array.isArray(ids) ? ids : []);
    return mutateBookmarks(list => ({
      bookmarks: list.filter(x => !drop.has(x.id)),
      remove: [...drop].map(id => DmkBookmarks.THUMB_PREFIX + id),
      result: { deleted: list.filter(x => drop.has(x.id)).length },
    }));
  },

  // Merge by id: unknown ids are added; known ones are replaced only when the
  // incoming copy is newer. Also used to undo a delete.
  async BOOKMARK_IMPORT({ bookmarks, thumbs }) {
    const raw = Array.isArray(bookmarks) ? bookmarks : [];
    const incoming = raw.map(sanitizeBookmark).filter(Boolean);
    const thumbMap = thumbs && typeof thumbs === 'object' ? thumbs : {};
    return mutateBookmarks(list => {
      const byId = new Map(list.map(b => [b.id, b]));
      const set = {};
      let added = 0;
      let updated = 0;
      for (const b of incoming) {
        const existing = byId.get(b.id);
        if (existing && existing.updatedAt >= b.updatedAt) continue;
        if (existing) updated++; else added++;
        byId.set(b.id, b);
        const thumb = Object.prototype.hasOwnProperty.call(thumbMap, b.id) ? thumbMap[b.id] : null;
        if (isValidThumb(thumb)) set[DmkBookmarks.THUMB_PREFIX + b.id] = thumb;
      }
      return {
        bookmarks: [...byId.values()],
        set,
        result: { added, updated, skipped: raw.length - added - updated },
      };
    });
  },

  async OPEN_BOOKMARK_MANAGER(_message, sender) {
    const url = chrome.runtime.getURL('bookmarks/manager.html');
    const tab = sender && sender.tab;
    await chrome.tabs.create(tab ? { url, index: tab.index + 1, windowId: tab.windowId } : { url });
    return {};
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  if (!Object.prototype.hasOwnProperty.call(bookmarkHandlers, type)) return false;
  bookmarkHandlers[type](message, sender).then(
    (result) => sendResponse({ success: true, ...result }),
    (err) => sendResponse({ success: false, error: err.message })
  );
  return true;
});
