// bookmarks/manager.js — the full-page scene bookmark manager.
//
// Reads bookmarks straight from chrome.storage.local and re-renders whenever
// they change (e.g. a bookmark saved in another tab). All writes go through
// the background store via DmkBookmarks.send.

const {
  THUMB_PREFIX, formatTime, formatExact, formatRange, parseTime, isClip, displayTitle,
} = DmkBookmarks;

const EXPORT_FORMAT = 'bahamut-danmaku-bookmarks';
const SORT_MODES = ['work', 'newest', 'oldest'];

const $ = (id) => document.getElementById(id);

const state = {
  bookmarks: [],
  thumbs: {},   // bookmark id → thumbnail data URL
  query: '',
  kind: 'all',  // all | moment | clip
  work: '',     // work title; '' = all
  tag: '',
  sort: SORT_MODES.includes(readPref('sort')) ? readPref('sort') : 'work',
};

let editing = null;

// ---- Data -----------------------------------------------------------------

async function load() {
  const bookmarks = await DmkBookmarks.loadAll();
  const stored = await chrome.storage.local.get(bookmarks.map(b => THUMB_PREFIX + b.id));
  state.bookmarks = bookmarks;
  state.thumbs = {};
  for (const b of bookmarks) {
    const thumb = stored[THUMB_PREFIX + b.id];
    if (thumb) state.thumbs[b.id] = thumb;
  }
  render();
}

let reloadTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!Object.keys(changes).some(k => k === 'bookmarks' || k.startsWith(THUMB_PREFIX))) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 100);
});

function workTitle(b) {
  return b.animeTitle || b.episodeTitle || DmkI18n.t('mgr.video', { sn: b.videoSn });
}

function episodeLabel(b) {
  if (!b.episode) return '';
  return /^\d+(\.\d+)?$/.test(b.episode) ? DmkI18n.t('mgr.episode', { n: b.episode }) : b.episode;
}

function imageFor(b) {
  return state.thumbs[b.id] || b.coverUrl || '';
}

function matches(b) {
  if (state.kind === 'clip' && !isClip(b)) return false;
  if (state.kind === 'moment' && isClip(b)) return false;
  if (state.work && workTitle(b) !== state.work) return false;
  if (state.tag && !b.tags.includes(state.tag)) return false;
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [
    b.title, b.note, b.animeTitle, b.episodeTitle, ...b.tags, ...b.danmaku.map(d => d.text),
  ].join('\n').toLowerCase();
  return terms.every(t => haystack.includes(t));
}

function byEpisodeThenTime(a, b) {
  return (parseFloat(a.episode) - parseFloat(b.episode)) ||
    (Number(a.videoSn) - Number(b.videoSn)) ||
    (a.start - b.start);
}

// Works ordered by their most recently saved scene; scenes in episode order.
function groupByWork(list) {
  const groups = new Map();
  for (const b of list) {
    const key = workTitle(b);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  return [...groups.entries()]
    .map(([title, items]) => ({
      title,
      items: items.sort(byEpisodeThenTime),
      latest: Math.max(...items.map(b => b.createdAt)),
    }))
    .sort((a, b) => b.latest - a.latest);
}

// ---- Rendering ------------------------------------------------------------

function render() {
  const all = state.bookmarks;
  // These may clear a filter whose work/tag no longer exists, so run them
  // before filtering.
  renderWorkOptions(all);
  renderTagFilter(all);
  renderSummary(all);
  for (const btn of $('kindFilter').querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.kind === state.kind);
  }

  const visible = all.filter(matches);
  $('empty').hidden = all.length > 0;
  $('noResults').hidden = all.length === 0 || visible.length > 0;
  document.querySelector('.filters').hidden = all.length === 0;

  const content = $('content');
  if (state.sort === 'work') {
    content.replaceChildren(...groupByWork(visible).map(renderGroup));
  } else {
    const dir = state.sort === 'newest' ? -1 : 1;
    const sorted = visible.slice().sort((a, b) => dir * (a.createdAt - b.createdAt));
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.append(...sorted.map(b => renderCard(b, true)));
    content.replaceChildren(...(sorted.length ? [grid] : []));
  }
}

function renderSummary(all) {
  const clips = all.filter(isClip).length;
  const works = new Set(all.map(workTitle)).size;
  $('summary').textContent = all.length
    ? DmkI18n.t('mgr.summary', {
      scenes: DmkI18n.t('mgr.scenes', { n: all.length }),
      clips: DmkI18n.t('mgr.clips', { n: clips }),
      works: DmkI18n.t('mgr.works', { n: works }),
    })
    : DmkI18n.t('mgr.summaryEmpty');
}

function renderWorkOptions(all) {
  const titles = [...new Set(all.map(workTitle))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  if (state.work && !titles.includes(state.work)) state.work = '';
  const select = $('workFilter');
  select.replaceChildren(new Option(DmkI18n.t('mgr.allWorks'), ''), ...titles.map(t => new Option(t, t)));
  select.value = state.work;
}

function renderTagFilter(all) {
  const counts = new Map();
  for (const b of all) for (const t of b.tags) counts.set(t, (counts.get(t) || 0) + 1);
  if (state.tag && !counts.has(state.tag)) state.tag = '';
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $('tagFilter').replaceChildren(...tags.map(([tag, n]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip${tag === state.tag ? ' active' : ''}`;
    btn.textContent = `#${tag}`;
    const count = document.createElement('span');
    count.className = 'chip-count';
    count.textContent = n;
    btn.appendChild(count);
    btn.addEventListener('click', () => {
      state.tag = state.tag === tag ? '' : tag;
      render();
    });
    return btn;
  }));
}

function renderGroup(group) {
  const node = $('groupTpl').content.firstElementChild.cloneNode(true);
  const withCover = group.items.find(b => b.coverUrl);
  const cover = node.querySelector('.group-cover');
  if (withCover) {
    cover.src = withCover.coverUrl;
    cover.addEventListener('error', () => cover.remove());
  } else {
    cover.remove();
  }

  const titleEl = node.querySelector('.group-title');
  const withSeries = group.items.find(b => b.animeSn);
  if (withSeries) {
    const link = document.createElement('a');
    link.href = `https://ani.gamer.com.tw/animeRef.php?sn=${encodeURIComponent(withSeries.animeSn)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = group.title;
    titleEl.appendChild(link);
  } else {
    titleEl.textContent = group.title;
  }

  const clips = group.items.filter(isClip).length;
  node.querySelector('.group-count').textContent =
    DmkI18n.t('mgr.scenes', { n: group.items.length }) + (clips ? ` · ${DmkI18n.t('mgr.clips', { n: clips })}` : '');
  node.querySelector('.grid').append(...group.items.map(b => renderCard(b, false)));
  return node;
}

function renderCard(b, showWork) {
  const card = $('cardTpl').content.firstElementChild.cloneNode(true);
  const clip = isClip(b);
  card.classList.toggle('is-clip', clip);

  const img = card.querySelector('.thumb img');
  const src = imageFor(b);
  if (src) {
    img.src = src;
    img.addEventListener('error', () => img.remove());
  } else {
    img.remove();
  }
  card.querySelector('.thumb-fallback').textContent = formatTime(b.start);

  const badge = card.querySelector('.badge');
  badge.textContent = clip ? formatTime(b.end - b.start) : '';
  badge.hidden = !clip;

  const work = card.querySelector('.card-work');
  work.textContent = workTitle(b);
  work.hidden = !showWork;

  const ep = card.querySelector('.card-ep');
  ep.textContent = episodeLabel(b);
  ep.hidden = !ep.textContent;
  card.querySelector('.card-time').textContent = formatRange(b);

  const title = card.querySelector('.card-title');
  title.textContent = displayTitle(b);
  title.classList.toggle('untitled', !b.title);

  const note = card.querySelector('.card-note');
  note.textContent = b.note;
  note.hidden = !b.note;

  const tags = card.querySelector('.card-tags');
  tags.hidden = !b.tags.length;
  tags.append(...b.tags.map(tag => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag';
    btn.textContent = `#${tag}`;
    btn.addEventListener('click', () => {
      state.tag = tag;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    return btn;
  }));

  const thumbBtn = card.querySelector('.thumb');
  thumbBtn.title = DmkI18n.t('mgr.playRange', { range: formatRange(b) });
  thumbBtn.addEventListener('click', () => playBookmark(b));
  card.querySelector('.act-play').addEventListener('click', () => playBookmark(b));
  card.querySelector('.act-edit').addEventListener('click', () => openEditor(b));
  card.querySelector('.act-delete').addEventListener('click', () => deleteBookmark(b));
  return card;
}

// ---- Actions --------------------------------------------------------------

// Reuses an open tab of the same episode (seeking in place) when there is
// one; otherwise opens a deep link that the content script resolves.
async function playBookmark(b) {
  try {
    const tabs = await chrome.tabs.query({ url: '*://ani.gamer.com.tw/animeVideo.php*' });
    const tab = tabs.find(t => sameVideo(t.url, b.videoSn));
    if (tab) {
      const res = await chrome.tabs
        .sendMessage(tab.id, { type: 'BOOKMARK_PLAY', videoSn: b.videoSn, start: b.start, end: b.end })
        .catch(() => null);
      if (res && res.success) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
    }
    await chrome.tabs.create({ url: DmkBookmarks.deepLink(b) });
  } catch (err) {
    showToast(DmkI18n.t('mgr.openFailed', { message: err.message }));
  }
}

function sameVideo(url, sn) {
  try {
    return new URL(url).searchParams.get('sn') === sn;
  } catch (_) {
    return false;
  }
}

async function deleteBookmark(b) {
  try {
    const undo = await DmkBookmarks.removeWithUndo(b);
    showToast(DmkI18n.t('mgr.deleted', { title: displayTitle(b) }), {
      label: DmkI18n.t('undo'),
      onClick: () => undo().catch(err => showToast(DmkI18n.t('mgr.undoFailed', { message: err.message }))),
    });
  } catch (err) {
    showToast(DmkI18n.t('mgr.deleteFailed', { message: err.message }));
  }
}

// ---- Editor ---------------------------------------------------------------

function openEditor(b) {
  editing = b;
  const src = imageFor(b);
  const thumb = $('edThumb');
  thumb.parentElement.hidden = !src;
  if (src) {
    thumb.src = src;
  } else {
    thumb.removeAttribute('src');
  }
  $('edEpisode').textContent = [workTitle(b), episodeLabel(b)].filter(Boolean).join(' · ');
  $('edStart').value = formatExact(b.start);
  $('edEnd').value = isClip(b) ? formatExact(b.end) : '';
  $('edTitle').value = b.title;
  $('edNote').value = b.note;
  $('edTags').value = b.tags.join(', ');
  $('edError').textContent = '';

  $('edDanmakuWrap').hidden = !b.danmaku.length;
  $('edDanmakuCount').textContent = b.danmaku.length;
  $('edDanmaku').replaceChildren(...b.danmaku.map(d => {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = formatTime(d.time);
    li.append(time, document.createTextNode(d.text));
    return li;
  }));

  $('editor').showModal();
  $('edTitle').focus();
}

$('editorForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const start = parseTime($('edStart').value);
  const endText = $('edEnd').value.trim();
  const end = endText ? parseTime(endText) : null;
  let error = '';
  if (Number.isNaN(start)) error = DmkI18n.t('mgr.errStart');
  else if (Number.isNaN(end)) error = DmkI18n.t('mgr.errEnd');
  else if (end != null && end <= start) error = DmkI18n.t('mgr.errOrder');
  if (error) {
    $('edError').textContent = error;
    return;
  }

  $('edSave').disabled = true;
  try {
    await DmkBookmarks.send('BOOKMARK_UPDATE', {
      id: editing.id,
      patch: {
        start,
        end,
        title: $('edTitle').value,
        note: $('edNote').value,
        tags: $('edTags').value,
      },
    });
    $('editor').close();
    showToast(DmkI18n.t('mgr.saved'));
  } catch (err) {
    $('edError').textContent = err.message;
  } finally {
    $('edSave').disabled = false;
  }
});

$('edCancel').addEventListener('click', () => $('editor').close());
$('edPlay').addEventListener('click', () => playBookmark(editing));
$('edDelete').addEventListener('click', () => {
  const b = editing;
  $('editor').close();
  deleteBookmark(b);
});
// The form fills the dialog, so a click landing on the dialog itself is a
// click on the backdrop.
$('editor').addEventListener('click', (e) => {
  if (e.target === $('editor')) $('editor').close();
});

// ---- Import / export ------------------------------------------------------

$('exportBtn').addEventListener('click', async () => {
  try {
    const bookmarks = await DmkBookmarks.loadAll();
    const stored = await chrome.storage.local.get(bookmarks.map(b => THUMB_PREFIX + b.id));
    const thumbs = {};
    for (const b of bookmarks) {
      if (stored[THUMB_PREFIX + b.id]) thumbs[b.id] = stored[THUMB_PREFIX + b.id];
    }
    const payload = {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      bookmarks,
      thumbs,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `scene-bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(DmkI18n.t('mgr.exported', { n: bookmarks.length }));
  } catch (err) {
    showToast(DmkI18n.t('mgr.exportFailed', { message: err.message }));
  }
});

$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.bookmarks)) throw new Error(DmkI18n.t('mgr.notExport'));
    const { added, updated, skipped } = await DmkBookmarks.send('BOOKMARK_IMPORT', {
      bookmarks: data.bookmarks,
      thumbs: data.thumbs || {},
    });
    showToast(DmkI18n.t('mgr.imported', { added, updated, skipped }));
  } catch (err) {
    showToast(DmkI18n.t('mgr.importFailed', { message: err.message }));
  }
});

// ---- Toast ----------------------------------------------------------------

let toastTimer = 0;
function showToast(message, action) {
  const toast = $('toast');
  const btn = $('toastAction');
  $('toastMsg').textContent = message;
  btn.hidden = !action;
  btn.textContent = action ? action.label : '';
  btn.onclick = action ? () => { toast.hidden = true; action.onClick(); } : null;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, action ? 7000 : 3500);
}

// ---- Controls -------------------------------------------------------------

$('search').addEventListener('input', (e) => {
  state.query = e.target.value;
  render();
});

$('kindFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-kind]');
  if (!btn) return;
  state.kind = btn.dataset.kind;
  render();
});

$('workFilter').addEventListener('change', (e) => {
  state.work = e.target.value;
  render();
});

$('sortMode').value = state.sort;
$('sortMode').addEventListener('change', (e) => {
  state.sort = e.target.value;
  writePref('sort', state.sort);
  render();
});

$('clearFilters').addEventListener('click', () => {
  Object.assign(state, { query: '', kind: 'all', work: '', tag: '' });
  $('search').value = '';
  render();
});

// "/" jumps to search, as on most sites.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select, dialog')) return;
  e.preventDefault();
  $('search').focus();
});

// Per-viewer conveniences only; the page works without them.
function readPref(key) {
  try { return localStorage.getItem(`dmk.${key}`); } catch (_) { return null; }
}

function writePref(key, value) {
  try { localStorage.setItem(`dmk.${key}`, value); } catch (_) {}
}

// The page and its templates are translated before the first render.
DmkI18n.load()
  .then(() => {
    DmkI18n.apply();
    DmkI18n.apply($('groupTpl').content);
    DmkI18n.apply($('cardTpl').content);
    return load();
  })
  .catch(err => showToast(DmkI18n.t('mgr.loadFailed', { message: err.message })));
