// opreport.js
//
// One-click report of a wrong OP guess (see opskip.js). A small "OP 不對"
// button shows above "skip OP" while the guessed OP plays and for
// OP_REPORT_AFTER_SEC after its end (where a wrong skip lands); the popup
// can send the same report for episodes where nothing was guessed.
//
// A pointer that rests on the left OP_REPORT_HINT_BAR of the progress bar,
// or in the lower-left corner of the player, early in the episode, is
// likely about to seek past the OP by hand: the guess is missing or wrong.
// After OP_REPORT_HINT_DWELL_MS there, a faint copy of the button shows
// just above the pointer (and above the bar's time tooltip), and hides
// OP_REPORT_HINT_HIDE_MS after the pointer leaves both.
//
// The viewer types nothing: the report is the episode number (sn), the
// guess, the video time of the click, the video length, the last
// OP_REPORT_SEEKS seeks in this episode (where a viewer jumps back or on
// after a wrong skip shows the real OP end) and the extension version.
// No account, name, cookie, comment text or other URL.
//
// Before the first report, a dialog lists exactly that and links to
// PRIVACY.md; only "agree" sends it and stores the agreement
// (OP_REPORT_CONSENT), which the settings page can take back. Later clicks send at
// once. background.js posts the report to the developer's Google Apps
// Script endpoint, which adds it to a sheet. When background.js has no
// endpoint set, the button stays hidden.

const OP_REPORT_AFTER_SEC = 15;
const OP_REPORT_SEEKS = 5;
const OP_REPORT_SEEK_AGE_MS = 5 * 60 * 1000;
const OP_REPORT_TOAST_MS = 4000;
const OP_REPORT_CONSENT = 'opReportConsent';
const OP_REPORT_HINT_BAR = 0.4;        // left share of the progress bar
const OP_REPORT_HINT_CORNER = 0.2;     // lower-left share of the player
const OP_REPORT_HINT_BAR_PAD_PX = 8;   // above and below the bar
const OP_REPORT_HINT_LIFT_PX = 56;     // above the bar or the pointer
const OP_REPORT_HINT_GAP_PX = 8;       // above the forward button (opskip.js)
const OP_REPORT_HINT_DWELL_MS = 300;
const OP_REPORT_HINT_HIDE_MS = 1500;

function initOpReport({ video, player, getVideoSn, getResult, isEnabled, log }) {
  let ready = false;
  let sn = null;
  let seeks = [];             // { from, to, at } in this episode
  let lastTime = 0;
  let busy = false;
  let toastTimer = 0;
  let toastFrom = null;       // the button the last report came from
  const reported = new Set(); // sn reported from this page

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dmk-op-report';
  button.hidden = true;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    opFocusPlayer(player);
    report();
  });

  const hint = document.createElement('button');
  hint.type = 'button';
  hint.className = 'dmk-op-report-float';
  hint.hidden = true;
  hint.addEventListener('click', (e) => {
    e.stopPropagation();
    opFocusPlayer(player);
    report(hint);
  });
  hint.addEventListener('pointerleave', hideHintSoon);
  let hintAt = null;          // { x, y } of the pointer in the zone
  let dwellTimer = 0;
  let hideTimer = 0;

  const toast = document.createElement('div');
  toast.className = 'dmk-op-toast';
  toast.setAttribute('role', 'status');
  toast.hidden = true;

  chrome.runtime.sendMessage({ type: 'OP_REPORT_READY' })
    .then((res) => {
      ready = !!(res && res.ready);
      sync();
    })
    .catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'OP_REPORT_OPEN') {
      sendResponse({ ok: ready });
      report();
    }
  });

  function sync() {
    const current = getVideoSn();
    if (current !== sn) {
      sn = current;
      seeks = [];
    }
    const op = getResult();
    const t = video.currentTime;
    const done = reported.has(sn);
    button.textContent = DmkI18n.t(done ? 'report.buttonDone' : 'report.button');
    button.title = DmkI18n.t('report.buttonTitle');
    button.disabled = done || busy;
    button.hidden = !(ready && isEnabled() && op && op.end !== undefined &&
      t >= op.start && t < op.end + OP_REPORT_AFTER_SEC &&
      !player.classList.contains('vjs-ad-playing') && !document.getElementById('dmk-op-report'));
    hint.textContent = button.textContent;
    hint.title = button.title;
    if (!hintAllowed()) hideHint();
    if (button.parentNode !== player) player.append(button, hint, toast);
  }

  function hintAllowed() {
    const duration = video.duration;
    return ready && isEnabled() && !!sn && !reported.has(sn) && !busy &&
      Number.isFinite(duration) && duration >= OP_MIN_VIDEO_SEC &&
      video.currentTime <= duration * OP_LATEST_FRACTION &&
      !player.classList.contains('vjs-ad-playing') && !document.getElementById('dmk-op-report');
  }

  // Where to lift the hint from (a viewport y), or null outside the zone.
  function hintAnchor(x, y) {
    const bar = player.querySelector('.vjs-progress-control');
    const r = bar && bar.getBoundingClientRect();
    if (r && r.width && x >= r.left && x <= r.left + r.width * OP_REPORT_HINT_BAR &&
        y >= r.top - OP_REPORT_HINT_BAR_PAD_PX && y <= r.bottom + OP_REPORT_HINT_BAR_PAD_PX) {
      return r.top;
    }
    const p = player.getBoundingClientRect();
    if (x >= p.left && x <= p.left + p.width * OP_REPORT_HINT_CORNER &&
        y <= p.bottom && y >= p.bottom - p.height * OP_REPORT_HINT_CORNER) {
      return r && r.width ? Math.min(y, r.top) : y;
    }
    return null;
  }

  function onPointerMove(e) {
    if (e.target === hint) return;
    const anchor = hintAllowed() ? hintAnchor(e.clientX, e.clientY) : null;
    if (anchor === null) {
      hintAt = null;
      clearTimeout(dwellTimer);
      dwellTimer = 0;
      hideHintSoon();
      return;
    }
    hintAt = { x: e.clientX, y: anchor };
    if (!hint.hidden) {
      clearTimeout(hideTimer);
      placeHint();
    } else if (!dwellTimer) {
      dwellTimer = setTimeout(() => {
        dwellTimer = 0;
        if (hintAt && hintAllowed()) {
          sync();
          hint.hidden = false;
          placeHint();
        }
      }, OP_REPORT_HINT_DWELL_MS);
    }
  }

  // Centred on the pointer, inside the player, and above the forward button
  // (opskip.js), which shows in the same corner.
  function placeHint() {
    const p = player.getBoundingClientRect();
    const w = hint.offsetWidth;
    const h = hint.offsetHeight;
    const left = Math.max(8, Math.min(hintAt.x - p.left - w / 2, p.width - w - 8));
    let top = Math.max(8, hintAt.y - p.top - OP_REPORT_HINT_LIFT_PX);
    const forward = player.querySelector('.dmk-op-forward:not([hidden])');
    if (forward) {
      const f = forward.getBoundingClientRect();
      const fl = f.left - p.left;
      const ft = f.top - p.top;
      if (left < fl + f.width && left + w > fl && top < ft + f.height && top + h > ft) {
        top = Math.max(8, ft - h - OP_REPORT_HINT_GAP_PX);
      }
    }
    hint.style.left = `${left}px`;
    hint.style.top = `${top}px`;
  }

  function hideHintSoon() {
    if (hint.hidden || hideTimer) return;
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      if (hintAt || hint.matches(':hover')) return;
      hint.hidden = true;
    }, OP_REPORT_HINT_HIDE_MS);
  }

  function hideHint() {
    clearTimeout(hideTimer);
    clearTimeout(dwellTimer);
    hideTimer = 0;
    dwellTimer = 0;
    hintAt = null;
    hint.hidden = true;
  }

  // `from`: the button clicked, so the message shows next to it.
  async function report(from = button) {
    hideHint();
    toastFrom = from;
    sync();
    if (!ready || !sn || busy) return;
    if (reported.has(sn)) {
      showToast(DmkI18n.t('report.already'));
      return;
    }
    // Taken at the click, before the consent dialog pauses the video.
    const op = getResult();
    const now = Date.now();
    const snapshot = {
      sn: Number(sn),
      at: Math.round(video.currentTime * 10) / 10,
      duration: Math.round(video.duration),
      guess: op ? { source: op.source, start: op.start ?? null, end: op.end ?? null } : null,
      seeks: seeks.filter(s => now - s.at < OP_REPORT_SEEK_AGE_MS)
        .slice(-OP_REPORT_SEEKS)
        .map(s => [s.from, s.to]),
    };

    busy = true;
    sync();
    try {
      const { [OP_REPORT_CONSENT]: agreed } = await chrome.storage.local.get(OP_REPORT_CONSENT);
      if (agreed !== true) {
        if (!await askConsent(snapshot.sn)) return;
        await chrome.storage.local.set({ [OP_REPORT_CONSENT]: true });
      }
      showToast(DmkI18n.t('report.sending'));
      const res = await chrome.runtime.sendMessage({ type: 'OP_REPORT', report: snapshot });
      if (!res || !res.ok) throw new Error((res && res.error) || 'no response');
      reported.add(sn);
      log('opReport', { sn, at: snapshot.at, seeks: snapshot.seeks.length });
      showToast(DmkI18n.t('report.thanks'));
    } catch (err) {
      const error = String(err && err.message || err);
      log('opReportError', { sn, error });
      showToast(DmkI18n.t('report.failed', { error }));
    } finally {
      busy = false;
      sync();
    }
  }

  // The one-time disclosure. Resolves true when the viewer agrees.
  function askConsent(reportSn) {
    return new Promise((resolve) => {
      const wasPlaying = !video.paused;
      video.pause();

      // Built with textContent only: no page text goes into the markup.
      const dialog = document.createElement('div');
      dialog.id = 'dmk-op-report';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');

      const title = document.createElement('div');
      title.className = 'dmk-report-title';
      title.textContent = DmkI18n.t('report.title');

      const notice = document.createElement('p');
      notice.className = 'dmk-report-notice';
      notice.textContent = DmkI18n.t('report.notice', { sn: reportSn });

      const once = document.createElement('p');
      once.className = 'dmk-report-once';
      once.textContent = DmkI18n.t('report.consentNote');

      const privacy = document.createElement('button');
      privacy.type = 'button';
      privacy.className = 'dmk-report-link';
      privacy.textContent = DmkI18n.t('report.privacy');
      privacy.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_PRIVACY' }).catch(() => {});
      });

      const actions = document.createElement('div');
      actions.className = 'dmk-report-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'dmk-btn-secondary';
      cancel.textContent = DmkI18n.t('report.cancel');
      const agree = document.createElement('button');
      agree.type = 'button';
      agree.textContent = DmkI18n.t('report.agree');
      actions.append(privacy, cancel, agree);

      dialog.append(title, notice, once, actions);
      // Keep clicks and keys away from the player (play/pause, seek shortcuts).
      for (const type of ['click', 'dblclick', 'keydown', 'keyup', 'keypress']) {
        dialog.addEventListener(type, (e) => e.stopPropagation());
      }
      player.appendChild(dialog);

      const close = (answer) => {
        dialog.remove();
        opFocusPlayer(player);
        if (wasPlaying) video.play().catch(() => {});
        resolve(answer);
      };
      cancel.addEventListener('click', () => close(false));
      agree.addEventListener('click', () => close(true));
      dialog.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close(false);
      });
      agree.focus();
    });
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    // Next to the floating copy when that was clicked; else the CSS place.
    const at = toastFrom === hint && hint.style.left ? hint : null;
    toast.style.left = at ? at.style.left : '';
    toast.style.top = at ? at.style.top : '';
    toast.style.right = at ? 'auto' : '';
    toast.style.bottom = at ? 'auto' : '';
    if (toast.parentNode !== player) player.appendChild(toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, OP_REPORT_TOAST_MS);
  }

  // Capture: the progress bar's own handlers must not hide moves from us.
  player.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  player.addEventListener('pointerleave', () => {
    hintAt = null;
    clearTimeout(dwellTimer);
    dwellTimer = 0;
    hideHintSoon();
  });

  video.addEventListener('timeupdate', () => {
    if (!video.seeking) lastTime = video.currentTime;
    sync();
  });
  // currentTime is already the target here; lastTime is where it was.
  video.addEventListener('seeking', () => {
    if (getVideoSn() !== sn) sync();
    const round = (n) => Math.round(n * 10) / 10;
    seeks.push({ from: round(lastTime), to: round(video.currentTime), at: Date.now() });
    if (seeks.length > OP_REPORT_SEEKS * 2) seeks.splice(0, seeks.length - OP_REPORT_SEEKS * 2);
  });
  video.addEventListener('seeked', () => {
    lastTime = video.currentTime;
    sync();
  });
  return { sync, report };
}
