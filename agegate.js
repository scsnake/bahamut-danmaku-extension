// agegate.js
//
// Optional (settings.autoAgreeAgeGate, on by default): clicks 同意 on the
// per-episode rating reminder (.video-cover-ncc) shown before playback, up
// to the highest rating tier (1..5, General through 18+ 限制級) that the
// viewer has manually agreed to on this logged-in Bahamut account.
//
// Why this does not bypass any age restriction:
// - Some 限制級 works also need the account's age verification
//   (animeAgeValidate.php, decided by payment method). Their notice says
//   「必須通過年齡驗證」 (level 6 in anime_player.js), and without the
//   verification the player shows Bahamut's 前往年齡驗證 error instead of
//   the video. The extension never touches this verification. A plain
//   限制級 notice (level 5) has no such check; only the notice.
// - Separately, the video player shows a rating reminder
//   (`div.R18 > .video-cover-ncc` with an image, text, and `button#adult`;
//   checked on 2026-10-28) before every episode at every rating (even
//   General 普遍級), and the rating is set per episode. The rating comes
//   from the image (TW-ALL … TW-18UP) or the text; levels 5 and 6 are one
//   18+ tier here. Bahamut's own player code (`agreeAgeGate()` in
//   anime_player.js) clicks this same button when opening a link with a
//   time code.
// - Nothing is ever clicked automatically before the viewer manually clicks
//   同意 (`Event.isTrusted === true`).
// - Cascade rule: when the viewer manually clicks 同意 on a rating tier N,
//   the extension remembers tier N for this account and auto-clicks 同意 on
//   subsequent episodes rated <= N (for example, manually agreeing to 18+
//   also auto-agrees to 15+, 12+, 6+, and General; manually agreeing to 15+
//   auto-agrees to 15+ and below, while 18+ still waits for the viewer's
//   own click).
// - Scoped per logged-in Bahamut account via a short SHA-256 hash of the
//   BAHAID cookie (`chrome.storage.local.ageGateConsent`:
//   `{ [hash]: { level, at } }`). Without a login, nothing is learned or
//   auto-clicked.

const AGE_GATE_RETRY_MS = 300;
const AGE_GATE_MAX_TRIES = 5;
const AGE_GATE_STORE = 'ageGateConsent';
const AGE_LEVEL_MAX = 5;

// Highest first; image file names and texts from anime_player.js.
const AGE_LEVEL_RULES = [
  [5, 'TW-18UP', '未滿18歲'],
  [4, 'TW-15TO18', '未滿15歲'],
  [3, 'TW-12TO15', '未滿12歲之兒童不宜'],
  [2, 'TW-6TO12', '未滿6歲'],
  [1, 'TW-ALL', '一般觀眾'],
];

function noticeLevel(gate) {
  const img = gate.querySelector('img');
  const src = img ? img.getAttribute('src') || '' : '';
  const text = (gate.querySelector('.ncc-choosebar p') || {}).textContent || '';
  for (const [level, file, phrase] of AGE_LEVEL_RULES) {
    if (src.includes(file) || text.includes(phrase)) return level;
  }
  return 0; // unknown notice: never agreed for the viewer
}

let ageAccountKey;   // undefined = not read yet, null = not logged in

async function currentAccountKey() {
  if (ageAccountKey !== undefined) return ageAccountKey;
  const match = document.cookie.match(/(?:^|;\s*)BAHAID=([^;]+)/);
  if (!match) return (ageAccountKey = null);
  const bytes = new TextEncoder().encode(decodeURIComponent(match[1]).toLowerCase());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  ageAccountKey = [...digest.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
  return ageAccountKey;
}

async function agreedLevel(account) {
  const { [AGE_GATE_STORE]: all = {} } = await chrome.storage.local.get(AGE_GATE_STORE);
  return Math.min((all[account] && all[account].level) || 0, AGE_LEVEL_MAX);
}

// Remembering tier `level` cascades to `level` and all lower tiers (1..level).
async function rememberLevel(account, clicked) {
  const level = Math.min(clicked, AGE_LEVEL_MAX);
  const { [AGE_GATE_STORE]: all = {} } = await chrome.storage.local.get(AGE_GATE_STORE);
  const before = (all[account] && all[account].level) || 0;
  if (level <= before) return false;
  all[account] = { level, at: Date.now() };
  await chrome.storage.local.set({ [AGE_GATE_STORE]: all });
  return true;
}

function watchAgeGate({ player, isEnabled, log }) {
  const listening = new WeakSet();   // agree buttons with our click listener
  const asked = new WeakSet();       // notices left for the viewer (logged once)
  let busy = false;
  let again = false;                 // a check came in while busy

  async function check() {
    if (busy) {
      again = true;
      return;
    }
    const agree = player.querySelector('.video-cover-ncc button#adult');
    if (!agree) return;
    const level = Math.min(noticeLevel(agree.closest('.video-cover-ncc')), AGE_LEVEL_MAX);

    if (!listening.has(agree)) {
      listening.add(agree);
      // The viewer's own click teaches this rating; ours is not trusted.
      agree.addEventListener('click', async (e) => {
        if (!e.isTrusted || !isEnabled() || !level) return;
        const account = await currentAccountKey();
        if (account && await rememberLevel(account, level)) log('ageGateLearned', { level });
      }, true);
    }
    if (!isEnabled() || !level) return;

    busy = true;
    try {
      const account = await currentAccountKey();
      const agreed = account ? await agreedLevel(account) : 0;
      if (level > agreed) {
        if (!asked.has(agree)) log('ageGateAsk', { level, agreed, loggedIn: !!account });
        asked.add(agree);
        return;
      }
      log('ageGateAgreed', { level, agreed });
      clickUntilGone(agree, 1);
    } finally {
      busy = false;
      if (again) {
        again = false;
        check();
      }
    }
  }

  // The player sets the button's handler right after it adds the layer;
  // click again in case the first click came too early.
  function clickUntilGone(agree, tries) {
    if (!agree.isConnected || tries > AGE_GATE_MAX_TRIES) return;
    agree.click();
    setTimeout(() => clickUntilGone(agree, tries + 1), AGE_GATE_RETRY_MS);
  }

  new MutationObserver(() => { check(); }).observe(player, { childList: true });
  check();
  // Turning the setting on while a notice shows agrees at once (if allowed).
  return { check };
}
