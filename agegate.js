// agegate.js
//
// Optional (settings.autoAgreeAgeGate, on by default): clicks 同意 on the
// rating notice the player shows before each episode, up to the highest
// rating the viewer has agreed to themselves on this Bahamut account.
//
// - The notice is a `div.R18` layer added to #ani_video, holding
//   `.video-cover-ncc` with an image, a text and button#adult (checked on
//   2026-10-28). The rating comes from the image (TW-ALL … TW-18UP) or the
//   text; levels 5 and 6 (限制級, and 限制級 with age verification) are one
//   18+ tier.
// - When the viewer clicks 同意 on a notice themselves, that rating and all
//   lower ones are agreed to from then on for this account. A higher rating
//   still waits for the viewer's own click. Age limits still come from the
//   account; the notice is a per-episode reminder, and the player itself
//   clicks the same button (agreeAgeGate()) when a link with a time code is
//   opened.
// - The account is the BAHAID cookie, stored only as a short SHA-256 hash
//   (chrome.storage.local `ageGateConsent`: { [hash]: { level, at } }).
//   Without a login nothing is agreed or learned.

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
  return (all[account] && all[account].level) || 0;
}

async function rememberLevel(account, level) {
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
