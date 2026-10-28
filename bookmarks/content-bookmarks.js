// bookmarks/content-bookmarks.js
//
// In-player half of scene bookmarks: a hover toolbar (save moment, mark clip,
// list this episode's bookmarks), keyboard shortcuts, a quick editor,
// deep-link seeking (#dmk=start[-end]) and clip playback that stops at the
// clip's end. content.js calls initBookmarks() once the player exists.
//
// Shortcuts (ignored while typing in any input):
//   B  bookmark the current moment
//   [  mark clip start      ]  mark clip end and save      Esc  cancel clip

const BM_SNIPPET_MAX = 30;
// Clips shorter than this are saved as a plain moment.
const BM_MIN_CLIP_SEC = 1;
// A video at least this long is taken to be the episode rather than a pre-roll
// ad when resolving a deep link.
const BM_MIN_EPISODE_SEC = 90;

const BM_ICONS = {
  star: 'M12 3.2l2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.3 2.8 1-6-4.4-4.2 6-.9z',
  clip: 'M9 4.5H5.5v15H9M15 4.5h3.5v15H15',
  list: 'M4.5 7h15M4.5 12h15M4.5 17h9',
};

function initBookmarks({ video, container, videoSn, getDanmaku }) {
  const { formatTime, formatRange, isClip, displayTitle } = DmkBookmarks;
  videoSn = String(videoSn);

  let episodeBookmarks = [];
  let pendingClip = null; // { start, thumb } until the clip end is marked
  let clipGuard = null;   // { start, end } while playing back a saved clip
  let closeEditor = null;

  // ---- DOM --------------------------------------------------------------

  const root = el('div');
  root.id = 'dmk-bm-root';

  const bar = el('div', 'dmk-bm-bar');
  const momentBtn = barButton(BM_ICONS.star, 'Save', 'Bookmark this moment (B)', true);
  const clipBtn = barButton(BM_ICONS.clip, 'Clip', 'Mark clip start, then end ([ and ])');
  const cancelClipBtn = el('button', 'dmk-bm-btn dmk-bm-cancel', '×');
  cancelClipBtn.title = 'Cancel clip (Esc)';
  cancelClipBtn.hidden = true;
  const listBtn = barButton(BM_ICONS.list, '0', 'Bookmarks in this episode');
  bar.append(momentBtn.btn, clipBtn.btn, cancelClipBtn, listBtn.btn);

  const panel = el('div', 'dmk-bm-panel');
  panel.hidden = true;
  const panelHead = el('div', 'dmk-bm-panel-head');
  const manageBtn = el('button', 'dmk-bm-link', 'Manage all ↗');
  panelHead.append(el('span', 'dmk-bm-panel-title', 'This episode'), manageBtn);
  const panelList = el('ul', 'dmk-bm-panel-list');
  const panelEmpty = el('p', 'dmk-bm-panel-empty',
    'Nothing saved yet. Press B to save a moment, or [ and ] to mark a clip.');
  panel.append(panelHead, panelList, panelEmpty);

  const toasts = el('div', 'dmk-bm-toasts');
  root.append(bar, panel, toasts);
  container.appendChild(root);

  // Keep clicks inside our UI from reaching the player (play/pause toggles,
  // double-click fullscreen).
  for (const type of ['click', 'dblclick', 'mousedown']) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }
  // Outside the editor, buttons must not take focus: a focused button would
  // swallow the space bar viewers use to pause.
  root.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') && !e.target.closest('.dmk-bm-editor')) e.preventDefault();
  });

  momentBtn.btn.addEventListener('click', saveMoment);
  clipBtn.btn.addEventListener('click', () => (pendingClip ? finishClip() : startClip()));
  cancelClipBtn.addEventListener('click', cancelClip);
  listBtn.btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    syncActive();
  });
  manageBtn.addEventListener('click', () => DmkBookmarks.send('OPEN_BOOKMARK_MANAGER').catch(reportError));

  // ---- Data -------------------------------------------------------------

  function setEpisodeBookmarks(all) {
    episodeBookmarks = all.filter(b => b.videoSn === videoSn).sort((a, b) => a.start - b.start);
    renderPanel();
  }

  DmkBookmarks.loadAll().then(setEpisodeBookmarks).catch(reportError);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.bookmarks) setEpisodeBookmarks(changes.bookmarks.newValue || []);
  });

  // ---- Saving -----------------------------------------------------------

  function saveMoment() {
    if (!ensurePlayable()) return;
    saveBookmark(video.currentTime, null, captureThumb());
  }

  function startClip() {
    if (!ensurePlayable()) return;
    pendingClip = { start: video.currentTime, thumb: captureThumb() };
    renderClipState();
    toast(`Clip starts at ${formatTime(pendingClip.start)} — press ] (or click the button) at the end`);
  }

  function finishClip() {
    if (!pendingClip) {
      toast('Press [ first to mark where the clip starts');
      return;
    }
    if (!ensurePlayable()) return;
    const a = pendingClip.start;
    const b = video.currentTime;
    // Seeking backwards before marking the end swaps the roles, and the frame
    // on screen is then the start frame.
    const thumb = a <= b ? pendingClip.thumb : captureThumb();
    pendingClip = null;
    renderClipState();
    const [start, end] = a <= b ? [a, b] : [b, a];
    saveBookmark(start, end - start >= BM_MIN_CLIP_SEC ? end : null, thumb);
  }

  function cancelClip() {
    pendingClip = null;
    renderClipState();
  }

  async function saveBookmark(start, end, thumb) {
    const bookmark = {
      id: DmkBookmarks.newId(),
      videoSn,
      ...readPageMeta(),
      start,
      end,
      title: '',
      note: '',
      tags: [],
      danmaku: danmakuAround(start, end),
    };
    try {
      const { bookmark: saved } = await DmkBookmarks.send('BOOKMARK_ADD', { bookmark, thumb });
      toast(`Saved ${isClip(saved) ? 'clip' : 'moment'} ${formatRange(saved)}`, [
        { label: 'Edit', onClick: () => openEditor(saved) },
        { label: 'Undo', onClick: () => DmkBookmarks.send('BOOKMARK_DELETE', { ids: [saved.id] }).catch(reportError) },
      ], 6000);
    } catch (err) {
      reportError(err);
    }
  }

  function ensurePlayable() {
    if (Number.isFinite(video.duration) && video.duration > 0 && !isAdPlaying()) return true;
    toast("The episode isn't playing yet");
    return false;
  }

  // TODO(verify): assumes Bahamut's pre-roll ads run through a videojs-ads
  // style plugin that tags the player with these classes.
  function isAdPlaying() {
    return container.classList.contains('vjs-ad-playing') || container.classList.contains('vjs-ad-loading');
  }

  // TODO(verify): `.anime_name h1` and the animeRef.php link are assumed from
  // Bahamut's markup; both fall back to document.title / null.
  function readPageMeta() {
    const h1 = document.querySelector('.anime_name h1');
    const episodeTitle = ((h1 && h1.textContent) || document.title)
      .replace(/\s*-\s*巴哈姆特動畫瘋\s*$/, '')
      .replace(/\s*線上看\s*$/, '')
      .trim();
    // "葬送的芙莉蓮 [3]" → work "葬送的芙莉蓮", episode "3".
    const m = /^(.*?)\s*\[([^\]]+)\]$/.exec(episodeTitle);
    const refLink = document.querySelector('a[href*="animeRef.php?sn="]');
    const og = document.querySelector('meta[property="og:image"]');
    return {
      episodeTitle,
      animeTitle: m ? m[1] : episodeTitle,
      episode: m ? m[2] : '',
      animeSn: refLink ? new URL(refLink.href, location.href).searchParams.get('sn') : null,
      coverUrl: og && og.content ? new URL(og.content, location.href).href : '',
    };
  }

  // Grabs a small JPEG of the current frame, or null when the frame can't be
  // read back (not decoded yet, cross-origin taint, or DRM black output).
  function captureThumb() {
    if (video.readyState < 2 || !video.videoWidth) return null;
    const width = 320;
    const height = Math.round((width * video.videoHeight) / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    try {
      ctx.drawImage(video, 0, 0, width, height);
      const px = ctx.getImageData(0, 0, width, height).data;
      let lit = false;
      for (let i = 0; i < px.length; i += 4 * 97) {
        if (px[i] || px[i + 1] || px[i + 2]) { lit = true; break; }
      }
      return lit ? canvas.toDataURL('image/jpeg', 0.72) : null;
    } catch (_) {
      return null;
    }
  }

  // Keeps what people were saying around the scene. Danmaku `time` is in
  // tenths of a second; reactions lag the moment, so pad more after than before.
  function danmakuAround(start, end) {
    const [from, to] = end == null ? [start - 3, start + 5] : [start - 1, end + 3];
    const hits = getDanmaku().filter(d => !d.isBlocked && d.text && d.time >= from * 10 && d.time <= to * 10);
    const step = Math.max(1, Math.ceil(hits.length / BM_SNIPPET_MAX));
    return hits
      .filter((_, i) => i % step === 0)
      .slice(0, BM_SNIPPET_MAX)
      .map(d => ({ time: d.time / 10, text: d.text }));
  }

  // ---- Playback ---------------------------------------------------------

  function playRange(start, end) {
    clipGuard = end != null && end > start ? { start, end } : null;
    video.currentTime = start;
    const p = video.play();
    if (p) p.catch(() => {});
    panel.hidden = true;
    syncActive();
  }

  video.addEventListener('timeupdate', () => {
    if (pendingClip) renderClipState();
    if (clipGuard && video.currentTime >= clipGuard.end) {
      const { start, end } = clipGuard;
      clipGuard = null;
      video.pause();
      toast(`Clip ended (${formatRange({ start, end })})`, [
        { label: 'Replay', onClick: () => playRange(start, end) },
        { label: 'Keep watching', onClick: () => video.play().catch(() => {}) },
      ], 8000);
    }
  });

  // Seeking outside the clip means the viewer moved on; stop guarding it.
  video.addEventListener('seeked', () => {
    if (clipGuard && (video.currentTime < clipGuard.start - 1 || video.currentTime > clipGuard.end)) {
      clipGuard = null;
    }
  });

  // TODO(verify): assumes the player's own "resume where you left off" logic
  // runs before playback starts; we re-apply the seek once if it moved us.
  function whenEpisodeReady(start, run) {
    const events = ['loadedmetadata', 'durationchange', 'canplay', 'playing'];
    const ready = () =>
      Number.isFinite(video.duration) && video.duration > Math.max(start, BM_MIN_EPISODE_SEC) && !isAdPlaying();
    const check = () => {
      if (!ready()) return;
      events.forEach(ev => video.removeEventListener(ev, check));
      run();
    };
    events.forEach(ev => video.addEventListener(ev, check));
    check();
  }

  function applyDeepLink() {
    const target = DmkBookmarks.parseDeepLinkHash(location.hash);
    if (!target) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    whenEpisodeReady(target.start, () => {
      const seekedAt = performance.now();
      playRange(target.start, target.end);
      video.addEventListener('playing', () => {
        if (performance.now() - seekedAt < 15000 && Math.abs(video.currentTime - target.start) > 5) {
          video.currentTime = target.start;
        }
      }, { once: true });
      toast(`Jumped to ${formatRange(target)}`);
    });
  }

  applyDeepLink();
  window.addEventListener('hashchange', applyDeepLink);

  // The manager page asks an already-open tab to seek instead of opening a new one.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'BOOKMARK_PLAY') return;
    const matches = String(message.videoSn) === videoSn;
    if (matches) playRange(Number(message.start), message.end == null ? null : Number(message.end));
    sendResponse({ success: matches });
  });

  // ---- Keyboard ---------------------------------------------------------

  // Capture phase so we see the key before the player's own hotkeys.
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) return;
    if (isEditable(e.target) || closeEditor) return;
    let handled = true;
    switch (e.code) {
      case 'KeyB': saveMoment(); break;
      case 'BracketLeft': startClip(); break;
      case 'BracketRight': finishClip(); break;
      case 'Escape':
        if (pendingClip) cancelClip();
        else handled = false;
        break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  function isEditable(node) {
    return node instanceof Element && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName));
  }

  // ---- Rendering --------------------------------------------------------

  function renderClipState() {
    const recording = !!pendingClip;
    clipBtn.btn.classList.toggle('dmk-bm-recording', recording);
    clipBtn.label.textContent = recording
      ? formatTime(Math.abs(video.currentTime - pendingClip.start))
      : 'Clip';
    clipBtn.btn.title = recording
      ? `Clip from ${formatTime(pendingClip.start)} — click or press ] to save`
      : 'Mark clip start, then end ([ and ])';
    cancelClipBtn.hidden = !recording;
    syncActive();
  }

  function renderPanel() {
    listBtn.label.textContent = String(episodeBookmarks.length);
    panelList.replaceChildren(...episodeBookmarks.map(renderRow));
    panelEmpty.hidden = episodeBookmarks.length > 0;
  }

  function renderRow(b) {
    const li = el('li', 'dmk-bm-row');
    const jump = el('button', 'dmk-bm-row-main');
    jump.title = b.note || 'Play from here';
    jump.append(
      el('span', 'dmk-bm-row-time', formatRange(b)),
      el('span', `dmk-bm-row-title${b.title ? '' : ' dmk-bm-untitled'}`, displayTitle(b))
    );
    jump.addEventListener('click', () => playRange(b.start, b.end));

    const edit = el('button', 'dmk-bm-icon-btn', '✎');
    edit.title = 'Edit';
    edit.addEventListener('click', () => openEditor(b));

    const del = el('button', 'dmk-bm-icon-btn dmk-bm-danger', '×');
    del.title = 'Delete';
    del.addEventListener('click', async () => {
      try {
        const undo = await DmkBookmarks.removeWithUndo(b);
        toast(`Deleted ${formatRange(b)}`, [{ label: 'Undo', onClick: () => undo().catch(reportError) }], 6000);
      } catch (err) {
        reportError(err);
      }
    });

    li.append(jump, edit, del);
    return li;
  }

  // Toolbar stays visible while something is in progress.
  function syncActive() {
    root.classList.toggle('dmk-bm-active', !!pendingClip || !panel.hidden || !!closeEditor);
  }

  function toast(message, actions = [], timeout = 3500) {
    const t = el('div', 'dmk-bm-toast');
    t.appendChild(el('span', 'dmk-bm-toast-msg', message));
    for (const action of actions) {
      const btn = el('button', 'dmk-bm-toast-btn', action.label);
      btn.addEventListener('click', () => {
        t.remove();
        action.onClick();
      });
      t.appendChild(btn);
    }
    toasts.appendChild(t);
    while (toasts.children.length > 3) toasts.firstChild.remove();
    setTimeout(() => t.remove(), timeout);
  }

  function reportError(err) {
    console.error('[Danmaku Enhancer] Bookmark error:', err);
    toast(`Bookmark failed: ${err.message}`);
  }

  // ---- Quick editor -----------------------------------------------------

  function openEditor(b) {
    if (closeEditor) closeEditor();
    const wasPlaying = !video.paused;
    video.pause();

    const form = el('form', 'dmk-bm-editor');
    const head = el('div', 'dmk-bm-editor-head');
    head.append(el('span', 'dmk-bm-editor-title', 'Edit bookmark'), el('span', 'dmk-bm-editor-time', formatRange(b)));

    const title = field('Title', el('input'));
    title.input.value = b.title;
    title.input.placeholder = isClip(b) ? 'e.g. OP, the big fight' : 'e.g. best line of the season';
    const note = field('Note', el('textarea'));
    note.input.rows = 3;
    note.input.value = b.note;
    const tags = field('Tags', el('input'));
    tags.input.value = b.tags.join(', ');
    tags.input.placeholder = 'Comma separated';

    const actions = el('div', 'dmk-bm-editor-actions');
    const cancel = el('button', 'dmk-bm-secondary', 'Cancel');
    cancel.type = 'button';
    const save = el('button', 'dmk-bm-primary', 'Save');
    save.type = 'submit';
    actions.append(cancel, save);
    form.append(head, title.wrap, note.wrap, tags.wrap, actions);

    const close = () => {
      form.remove();
      closeEditor = null;
      syncActive();
      if (wasPlaying) video.play().catch(() => {});
    };

    cancel.addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      try {
        await DmkBookmarks.send('BOOKMARK_UPDATE', {
          id: b.id,
          patch: { title: title.input.value, note: note.input.value, tags: tags.input.value },
        });
        close();
        toast('Bookmark updated');
      } catch (err) {
        save.disabled = false;
        reportError(err);
      }
    });
    // Typing here must not trigger the player's hotkeys (space, f, arrows…).
    for (const type of ['keydown', 'keyup', 'keypress']) {
      form.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'keydown' && e.key === 'Escape') close();
      });
    }

    closeEditor = close;
    root.appendChild(form);
    syncActive();
    title.input.focus();
  }

  // ---- Helpers ----------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function field(labelText, input) {
    const wrap = el('label', 'dmk-bm-field');
    wrap.append(el('span', 'dmk-bm-field-label', labelText), input);
    return { wrap, input };
  }

  function barButton(pathD, labelText, title, filled = false) {
    const btn = el('button', 'dmk-bm-btn');
    btn.type = 'button';
    btn.title = title;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (filled) svg.classList.add('dmk-bm-filled');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    svg.appendChild(path);
    const label = el('span', 'dmk-bm-btn-label', labelText);
    btn.append(svg, label);
    return { btn, label };
  }
}
