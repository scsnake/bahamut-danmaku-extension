// search/search.js — find danmaku keywords (for example 高能) across works.
//
// 1. Works: the viewer's subscribed works (mygather.php) and watch history
//    (history.php, 30 works per page, newest first) — both need the Bahamut
//    login cookie — works added by URL, and the work open in the current tab
//    (?videoSn= from the popup).
// 2. Episodes: animeRef.php?sn= redirects to one episode; video.php for that
//    episode lists all of the work's episodes.
// 3. Danmaku: danmu.php per episode, the same request as the player (with
//    the cookie, so the viewer's official keyword filters and mutes apply).
// Matching comments close in time form one "moment", linked to the episode
// at that time (animeVideo.php?sn=…&t=<seconds>). Lists are kept in memory
// for this page, so a second search does not fetch them again.

const ANI = 'https://ani.gamer.com.tw';
const VIDEO_API = 'https://api.gamer.com.tw/anime/v1/video.php';
const DANMU_API = 'https://api.gamer.com.tw/anime/v1/danmu.php';
const HISTORY_API = 'https://api.gamer.com.tw/anime/v3/history.php';
const MAX_GATHER_PAGES = 30;
// Requests at the same time; keeps the load on Bahamut low.
const FETCH_CONCURRENCY = 3;
const MOMENT_GAP_TENTHS = 100;   // hits closer than 10 s form one moment
const LEAD_IN_SEC = 3;           // links start a little before the first hit
const SAMPLE_TEXTS = 3;

const { t } = DmkI18n;
const $ = (id) => document.getElementById(id);

// key ('ref:<animeRef sn>' or 'video:<videoSn>') -> work
const works = new Map();
const danmuCache = new Map();    // videoSn -> [{ time, text, norm }]
let results = [];                // [{ work, episode, moments }]
let run = null;                  // { cancelled } while a search runs
let historyPage = 0;             // watch-history pages loaded so far
let historyPages = Infinity;     // totalPage from the API

// ---- Works ------------------------------------------------------------------

function addWork(work) {
  if (works.has(work.key)) {
    works.get(work.key).checked = true;
  } else {
    works.set(work.key, { checked: false, ...work });
  }
  renderWorks();
}

async function loadFavorites() {
  $('loadFavs').disabled = true;
  showMsg('worksMsg', t('search.loadingFavs'));
  let found = 0;
  try {
    for (let page = 1; page <= MAX_GATHER_PAGES; page++) {
      const html = await fetch(`${ANI}/mygather.php?page=${page}`, { credentials: 'include' }).then(r => r.text());
      const doc = new DOMParser().parseFromString(html, 'text/html');
      let added = 0;
      for (const card of doc.querySelectorAll('a.theme-list-main[href*="animeRef.php?sn="]')) {
        const refSn = new URL(card.getAttribute('href'), ANI).searchParams.get('sn');
        if (!refSn || works.has(`ref:${refSn}`)) continue;
        const img = card.querySelector('img.theme-img');
        works.set(`ref:${refSn}`, {
          key: `ref:${refSn}`,
          refSn,
          title: text(card.querySelector('.theme-name')) || `#${refSn}`,
          info: text(card.querySelector('.theme-number')),
          cover: img ? img.getAttribute('data-src') || img.getAttribute('src') || '' : '',
          checked: false,
        });
        added++;
      }
      found += added;
      // A page past the end repeats earlier works or lists none.
      if (!added) break;
    }
    showMsg('worksMsg', found ? '' : t('search.noFavs'));
  } catch (err) {
    showMsg('worksMsg', t('search.loadFailed', { message: err.message }));
  } finally {
    $('loadFavs').disabled = false;
    renderWorks();
  }
}

// Each click loads the next page of the watch history (one entry per work,
// with the last episode watched).
async function loadHistory() {
  const button = $('loadHistory');
  button.disabled = true;
  showMsg('worksMsg', t('search.loadingHistory'));
  try {
    const json = await fetchJson(`${HISTORY_API}?page=${historyPage + 1}`);
    const data = (json && json.data) || {};
    const list = data.history || [];
    historyPages = Number(data.totalPage) || historyPage + 1;
    historyPage++;
    for (const h of list) {
      const key = `anime:${h.animeSn}`;
      if (works.has(key)) continue;
      works.set(key, {
        key,
        animeSn: String(h.animeSn),
        videoSn: String(h.videoSn),
        title: h.title || `#${h.animeSn}`,
        info: h.episode ? t('search.watchedUpTo', { episode: episodeText(h.episode) }) : '',
        cover: h.cover || '',
        checked: false,
      });
    }
    showMsg('worksMsg', list.length || historyPage > 1 ? '' : t('search.noHistory'));
  } catch (err) {
    showMsg('worksMsg', t('search.loadFailed', { message: err.message }));
  } finally {
    const more = historyPage < historyPages;
    button.textContent = t(historyPage && more ? 'search.loadMoreHistory' : 'search.loadHistory');
    button.disabled = !more;
    renderWorks();
  }
}

// Accepts an animeVideo.php or animeRef.php URL, or an episode sn.
async function addWorkFromInput() {
  const raw = $('addWork').value.trim();
  if (!raw) return;
  let work = null;
  if (/^\d+$/.test(raw)) {
    work = { key: `video:${raw}`, videoSn: raw };
  } else {
    try {
      const url = new URL(raw);
      const sn = url.searchParams.get('sn');
      if (sn && url.pathname.endsWith('/animeVideo.php')) work = { key: `video:${sn}`, videoSn: sn };
      if (sn && url.pathname.endsWith('/animeRef.php')) work = { key: `ref:${sn}`, refSn: sn };
    } catch (_) {}
  }
  if (!work) {
    showMsg('worksMsg', t('search.badWork'));
    return;
  }
  $('addWork').value = '';
  await addResolvedWork(work);
}

// Adds a work picked by URL or from the current tab, checked, with its title.
async function addResolvedWork(work) {
  work.title = work.title || `#${work.videoSn || work.refSn}`;
  work.checked = true;
  addWork(work);
  try {
    await resolveEpisodes(works.get(work.key));
    showMsg('worksMsg', '');
  } catch (err) {
    showMsg('worksMsg', t('search.loadFailed', { message: err.message }));
  }
  renderWorks();
}

// Fills work.episodes (and the title when missing). Cached on the work.
async function resolveEpisodes(work) {
  if (work.episodes) return work.episodes;
  if (!work.videoSn) {
    const res = await fetch(`${ANI}/animeRef.php?sn=${encodeURIComponent(work.refSn)}`, { credentials: 'include' });
    // Only the final URL is needed, not the page.
    if (res.body) res.body.cancel().catch(() => {});
    work.videoSn = new URL(res.url).searchParams.get('sn');
    if (!work.videoSn) throw new Error(t('search.noEpisode'));
  }
  const json = await fetchJson(`${VIDEO_API}?videoSn=${encodeURIComponent(work.videoSn)}`);
  const anime = json && json.data && json.data.anime;
  if (!anime) throw new Error(t('search.noEpisode'));
  work.animeSn = String(anime.animeSn);
  // The API's title ends with the current episode, as in "魔法少女小圓 [12]".
  if (!work.refSn || work.title.startsWith('#')) work.title = String(anime.title || work.title).replace(/\s*\[[^\]]*\]$/, '');
  if (!work.cover && anime.cover) work.cover = anime.cover;
  work.episodes = Object.entries(anime.episodes || {}).flatMap(([group, list]) =>
    list.map(e => ({ group, episode: String(e.episode), videoSn: String(e.videoSn) })));
  if (!work.info) work.info = t('search.episodeCount', { n: work.episodes.length });
  return work.episodes;
}

function renderWorks() {
  const filter = norm($('workFilter').value.trim());
  const list = $('workList');
  const items = [...works.values()].filter(w => !filter || norm(w.title).includes(filter));
  list.replaceChildren(...items.map(w => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = w.checked;
    box.addEventListener('change', () => {
      w.checked = box.checked;
      renderWorkCount();
    });
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    if (w.cover) img.src = w.cover;
    const name = document.createElement('span');
    name.className = 'work-title';
    name.textContent = w.title;
    const info = document.createElement('span');
    info.className = 'muted';
    info.textContent = w.info || '';
    label.append(box, img, name, info);
    li.appendChild(label);
    return li;
  }));
  renderWorkCount();
}

function renderWorkCount() {
  const checked = [...works.values()].filter(w => w.checked).length;
  $('workCount').textContent = works.size ? t('search.selected', { n: checked, total: works.size }) : '';
}

function setVisibleChecked(checked) {
  const filter = norm($('workFilter').value.trim());
  for (const w of works.values()) {
    if (!filter || norm(w.title).includes(filter)) w.checked = checked;
  }
  renderWorks();
}

// ---- Search -----------------------------------------------------------------

async function startSearch() {
  const keywords = $('keywords').value.split(/[,，、]+/).map(k => norm(k.trim())).filter(Boolean);
  const minCount = Math.max(1, Number($('minCount').value) || 1);
  const chosen = [...works.values()].filter(w => w.checked);
  if (!keywords.length) return showMsg('searchMsg', t('search.needKeyword'));
  if (!chosen.length) return showMsg('searchMsg', t('search.needWork'));
  showMsg('searchMsg', '');

  run = { cancelled: false };
  const current = run;
  setRunning(true);
  results = [];
  renderResults();
  let failed = 0;

  // Episodes of each chosen work.
  let done = 0;
  await pool(chosen, async (work) => {
    try {
      await resolveEpisodes(work);
    } catch (err) {
      failed++;
    }
    progress(++done, chosen.length, 'search.progressWorks');
  }, current);

  // Danmaku of each episode. A work picked from two lists (subscriptions
  // and history) is searched once.
  const seen = new Set();
  const unique = chosen.filter(w => !w.animeSn || !seen.has(w.animeSn) && seen.add(w.animeSn));
  const jobs = unique.flatMap(work => (work.episodes || []).map(episode => ({ work, episode })));
  done = 0;
  progress(0, jobs.length, 'search.progressEpisodes');
  await pool(jobs, async ({ work, episode }) => {
    try {
      const list = await loadDanmu(episode.videoSn);
      const moments = findMoments(list, keywords).filter(m => m.count >= minCount);
      if (moments.length) {
        results.push({ work, episode, moments });
        scheduleRender();
      }
    } catch (err) {
      failed++;
    }
    progress(++done, jobs.length, 'search.progressEpisodes');
  }, current);

  if (run !== current) return;
  run = null;
  setRunning(false);
  renderResults();
  const notes = [];
  if (current.cancelled) notes.push(t('search.cancelled'));
  if (failed) notes.push(t('search.failedCount', { n: failed }));
  showMsg('searchMsg', notes.join(' '));
}

async function loadDanmu(videoSn) {
  if (danmuCache.has(videoSn)) return danmuCache.get(videoSn);
  const json = await fetchJson(`${DANMU_API}?videoSn=${encodeURIComponent(videoSn)}&geo=TW%2CHK`);
  const list = ((json && json.data && json.data.danmu) || [])
    .map(d => ({ time: d.time, text: d.text, norm: norm(d.text || '') }))
    .sort((a, b) => a.time - b.time);
  danmuCache.set(videoSn, list);
  return list;
}

// Groups matching comments that are close in time.
function findMoments(list, keywords) {
  const moments = [];
  let current = null;
  for (const d of list) {
    if (!keywords.some(k => d.norm.includes(k))) continue;
    if (current && d.time - current.lastTenths <= MOMENT_GAP_TENTHS) {
      current.count++;
      current.lastTenths = d.time;
      if (current.samples.length < SAMPLE_TEXTS && !current.samples.includes(d.text)) current.samples.push(d.text);
      continue;
    }
    current = { startTenths: d.time, lastTenths: d.time, count: 1, samples: [d.text] };
    moments.push(current);
  }
  return moments;
}

function momentLink(episode, moment) {
  const sec = Math.max(0, Math.floor(moment.startTenths / 10) - LEAD_IN_SEC);
  return `${ANI}/animeVideo.php?sn=${encodeURIComponent(episode.videoSn)}&t=${sec}`;
}

// ---- Results ----------------------------------------------------------------

let renderPending = 0;
function scheduleRender() {
  if (renderPending) return;
  renderPending = requestAnimationFrame(() => {
    renderPending = 0;
    renderResults();
  });
}

function renderResults() {
  const panel = $('resultsPanel');
  const box = $('results');
  const total = results.reduce((n, r) => n + r.moments.length, 0);
  panel.hidden = !results.length && !run;
  $('resultSummary').textContent = t('search.summary', { moments: total, episodes: results.length });

  if ($('sortMode').value === 'count') {
    const flat = results.flatMap(r => r.moments.map(m => ({ ...r, moment: m })));
    flat.sort((a, b) => b.moment.count - a.moment.count);
    const ul = document.createElement('ul');
    ul.className = 'moments';
    ul.append(...flat.map(r => momentItem(r.episode, r.moment, `${r.work.title} · ${episodeLabel(r.episode)}`)));
    box.replaceChildren(ul);
    return;
  }

  // By work, in the work list's order; episodes in order.
  const order = [...works.keys()];
  const byWork = new Map();
  for (const r of results) {
    if (!byWork.has(r.work.key)) byWork.set(r.work.key, []);
    byWork.get(r.work.key).push(r);
  }
  const sections = [...byWork.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([, items]) => {
      const section = document.createElement('section');
      section.className = 'result-work';
      const h3 = document.createElement('h3');
      h3.textContent = items[0].work.title;
      section.appendChild(h3);
      const episodes = items[0].work.episodes || [];
      items.sort((a, b) => episodes.indexOf(a.episode) - episodes.indexOf(b.episode));
      for (const r of items) {
        const h4 = document.createElement('h4');
        h4.textContent = episodeLabel(r.episode);
        const ul = document.createElement('ul');
        ul.className = 'moments';
        ul.append(...r.moments.map(m => momentItem(r.episode, m)));
        section.append(h4, ul);
      }
      return section;
    });
  box.replaceChildren(...sections);
}

function momentItem(episode, moment, prefix) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = momentLink(episode, moment);
  a.target = '_blank';
  a.rel = 'noopener';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(moment.startTenths / 10);
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = t('search.hits', { n: moment.count });
  const samples = document.createElement('span');
  samples.className = 'samples';
  // Comment text: textContent only.
  samples.textContent = (prefix ? `${prefix} — ` : '') + moment.samples.join(' · ');
  a.append(time, count, samples);
  li.appendChild(a);
  return li;
}

function episodeText(episode) {
  return /^\d+(\.\d+)?$/.test(episode) ? t('mgr.episode', { n: episode }) : episode;
}

function episodeLabel(episode) {
  const label = episodeText(episode.episode);
  // Episode groups other than "0" are other versions (for example a dub).
  return episode.group === '0' ? label : `${label} · ${t('search.otherVersion', { n: episode.group })}`;
}

// ---- Helpers ----------------------------------------------------------------

// Runs fn over items, FETCH_CONCURRENCY at a time, until done or cancelled.
async function pool(items, fn, current) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !current.cancelled) {
      await fn(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, worker));
}

async function fetchJson(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function progress(done, total, key) {
  $('progress').max = Math.max(1, total);
  $('progress').value = done;
  $('progressText').textContent = t(key, { done, total });
}

function setRunning(running) {
  $('searchBtn').disabled = running;
  $('cancelBtn').hidden = !running;
  $('progressRow').hidden = !running;
}

function showMsg(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}

// Full-width letters and digits match their ASCII forms; case is ignored.
function norm(s) {
  return String(s).normalize('NFKC').toLowerCase();
}

function text(el) {
  return el ? el.textContent.trim().replace(/\s+/g, ' ') : '';
}

function formatTime(sec) {
  const whole = Math.floor(sec);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const ss = String(whole % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ---- Start ------------------------------------------------------------------

$('loadFavs').addEventListener('click', loadFavorites);
$('loadHistory').addEventListener('click', loadHistory);
$('addWorkBtn').addEventListener('click', addWorkFromInput);
$('addWork').addEventListener('keydown', (e) => { if (e.key === 'Enter') addWorkFromInput(); });
$('workFilter').addEventListener('input', renderWorks);
$('selectAll').addEventListener('click', () => setVisibleChecked(true));
$('selectNone').addEventListener('click', () => setVisibleChecked(false));
$('searchBtn').addEventListener('click', startSearch);
$('keywords').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !run) startSearch(); });
$('cancelBtn').addEventListener('click', () => { if (run) run.cancelled = true; });
$('sortMode').addEventListener('change', renderResults);

DmkI18n.load().then(() => {
  DmkI18n.apply();
  const videoSn = new URLSearchParams(location.search).get('videoSn');
  if (videoSn && /^\d+$/.test(videoSn)) addResolvedWork({ key: `video:${videoSn}`, videoSn });
});
