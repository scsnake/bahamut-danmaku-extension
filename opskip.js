// opskip.js
//
// Guesses where the opening song (OP) is from the danmaku, marks its start
// and end on the density curve, and shows a "skip OP" button while it plays.
// Shares the density curve's setting (settings.densityEnabled).
//
// Viewers mark the OP for each other:
// - "空降時間 1:30" / "空降座標 1.30" / "請空降至02:20", posted when the OP
//   starts: the time in the text is where the OP ends (the end is put
//   OP_JUMP_EARLY_SEC before it, so the jump lands just before the episode
//   goes on). Each such comment is a vote; targets within OP_GROUP_SEC of
//   each other count together, and the group with the most votes wins.
//   Its earliest comment is the start.
//   Targets that are not OP_MIN_SEC–OP_MAX_SEC after their comment
//   ("空降座標24:00" as a joke, "空降 0:30" near the end) are not votes.
// - "空降成功" / "謝謝指揮官", posted just after the jump lands: without a
//   usable target, the busiest OP_WINDOW_SEC of these comments is the end,
//   and the start is OP_DEFAULT_SEC before it (or the beginning of the
//   episode when that is close).
// - "op君" (a greeting, "op君好久不見") comes in a burst when the OP starts.
//   "不跳OP" / "OP不跳" / "不跳" is posted when it starts, but also at its end
//   ("不跳OP，我驕傲"). Both move the start earlier, to their busiest window
//   OP_SHORTEST_SEC–OP_MAX_SEC before an end found above. Without such an end,
//   a burst of OP_GREET_MIN "op君" alone is the start, and the OP is
//   OP_DEFAULT_SEC long; "不跳" alone places nothing.
// - "開頭OP" ("開頭OP必有大事") in the first OP_OPENING_EARLY_SEC says the
//   OP starts the episode: the start is 0 when the end found above is
//   within OP_MAX_SEC, and OP_OPENING_MIN of them alone give 0 to
//   OP_DEFAULT_SEC. Later ones are the meme, not a position.
// - Last, comments that name the OP at all ("神OP", "居然有OP", "op君",
//   "不跳OP") come all through it, and most at its start or its end. The
//   OP_DEFAULT_SEC span with the most of them (at least OP_TALK_MIN) is the OP.
// - "op君陣亡" / "OP已死" / "OP君已離線" / "op君……是誰" / "所以我說op呢" /
//   "為op君上香" / "沒OP" / "無OP": this episode has no OP ("op君" is posted
//   both when the OP is back and when it is missing). When these outnumber the clues above (and there are at least
//   OP_NONE_MIN), no OP is shown. "op君死亡回歸" / "死歸" (Re:Zero) means it
//   is back.
// The OP must start in the first OP_LATEST_FRACTION of the video, so a
// cluster near the end of a film or an OP played as the ending is ignored.
// Episode 1 often plays the series' OP song only at its end, and viewers
// still call it "OP" there.
// Films (劇場版, or OP_FILM_MIN_SEC and longer) often have no OP or a
// different one, so for them only "空降 {time}" votes count.
// All comments count here, also the ones the viewer's filters hide.
// content.js calls update() whenever the list changes.
//
// In debug mode (keepReview), episodes where nothing could be placed are
// kept for review in chrome.storage.local (OP_REVIEW_STORE, newest
// OP_REVIEW_MAX), with their OP-related comments; the popup exports them
// with the debug log. An episode that gets a result later is removed.

const OP_DEFAULT_SEC = 88;
const OP_JUMP_EARLY_SEC = 2;
const OP_MIN_SEC = 20;
// A start clue ("op君", "不跳") closer to the end than this is posted during
// the OP, not at its start (a TV OP is about 90 s).
const OP_SHORTEST_SEC = 70;
const OP_MAX_SEC = 150;
const OP_GROUP_SEC = 3;
const OP_WINDOW_SEC = 10;
const OP_START_SNAP_SEC = 15;   // a start this close to 0 is the beginning
const OP_GREET_MIN = 2;
const OP_NONE_MIN = 2;
const OP_TALK_MIN = 4;
const OP_OPENING_MIN = 2;
const OP_OPENING_EARLY_SEC = 30;
const OP_LATEST_FRACTION = 0.4;
const OP_FILM_MIN_SEC = 45 * 60;
const OP_FILM_TITLE_RE = /劇場版|剧场版|電影版|电影版|movie/i;
// Same limit as the density curve: shorter videos are pre-roll ads.
const OP_MIN_VIDEO_SEC = 60;
// Matched after NFKC, so full-width digits, letters and "：" match too.
const OP_JUMP_RE = /空降\s*(?:時間|时间|座標|坐標|坐标|座标|點|点)?\s*(?:至|到)?\s*:?\s*(\d{1,2})\s*[:.]\s*([0-5]\d)(?!\d)/;
const OP_LANDED_RE = /空降成功|[謝谢]{2}指[揮挥]官/;
// "op" then up to 8 characters, then a word for gone, dead or missing; or
// "沒OP" / "無OP" / "誰是OP" in front.
const OP_NONE_RE = new RegExp(
  'op.{0,8}?(?:陣亡|阵亡|卒|罷工|罢工|(?<!久)不[見见]|[請请]假|[掛挂]了|[沒没]了|上香|掰|bye|r\\.?i\\.?p|安息|' +
  '[離离下]線|[離离下]线|是[誰谁]|[呢勒咧](?![a-z])|qq|哭|[傷伤]心|[懷怀]念|被.{0,4}吃|去哪|在哪|' +
  '(?<!笑)死(?!亡?回?[歸归]))|[沒没無无]有?\\s*op|[誰谁]是\\s*op', 'i');
const OP_GREET_RE = /op\s*君/i;
const OP_OPENING_RE = /[開开][頭头]\s*op/i;
const OP_STAY_RE = /不跳過?\s*op|op.{0,12}不跳|^.{0,6}不跳[\s!~.。]*$/i;
// "op" as a word, not inside "open" or "stop".
const OP_TALK_RE = /(?<![a-z])op(?![a-z])/i;
const OP_REVIEW_STORE = 'opSkipReview';
const OP_REVIEW_MAX = 300;
const OP_REVIEW_SAMPLES = 30;
const OP_SAMPLE_RE = /op|空降|跳|指[揮挥]|片頭|片头|主題曲|主题曲/i;

// Returns { start, end, source, votes } in seconds, { source: 'none', votes }
// when viewers say this episode has no OP, or { source: 'unknown' } when
// nothing is known; each with the number of comments per kind of clue.
function findOpening(list, duration, film = false) {
  const latest = duration * OP_LATEST_FRACTION;
  const jumps = [];
  const landed = [];
  const none = [];
  const greets = [];
  const stays = [];
  const talk = [];
  const openings = [];
  for (const d of list) {
    const text = String(d.text || '').normalize('NFKC');
    const sec = d.time / 10;
    const m = text.match(OP_JUMP_RE);
    if (m) {
      const target = Number(m[1]) * 60 + Number(m[2]);
      const length = target - sec;
      if (sec <= latest && length >= OP_MIN_SEC && length <= OP_MAX_SEC && target < duration) {
        jumps.push({ sec, target });
      }
      continue;
    }
    if (OP_LANDED_RE.test(text)) {
      if (sec <= latest + OP_MAX_SEC) landed.push(sec);
      continue;
    }
    if (OP_NONE_RE.test(text)) {
      none.push(sec);
      continue;
    }
    if (sec > latest) continue;
    if (sec <= OP_OPENING_EARLY_SEC && OP_OPENING_RE.test(text)) openings.push(sec);
    if (OP_GREET_RE.test(text)) greets.push(sec);
    else if (OP_STAY_RE.test(text)) stays.push(sec);
    if (OP_TALK_RE.test(text) || OP_STAY_RE.test(text)) talk.push(sec);
  }
  const clues = {
    jump: jumps.length, landed: landed.length, none: none.length,
    greet: greets.length, stay: stays.length, talk: talk.length, opening: openings.length,
  };
  const found = guess();
  return Object.assign(found || { source: 'unknown' }, { clues }, film ? { film } : {});

  function guess() {
    if (none.length >= OP_NONE_MIN &&
        none.length > jumps.length + landed.length + greets.length + stays.length + openings.length) {
      return { source: 'none', votes: none.length };
    }

    // The earliest busiest start-clue window that fits an OP ending at `end`;
    // 0 when "開頭OP" says the OP starts the episode and `end` allows it.
    const startBefore = (end) => {
      if (openings.length && end <= OP_MAX_SEC) return 0;
      const fit = busiestWindow(greets.concat(stays)
        .filter(t => t >= end - OP_MAX_SEC && t <= end - OP_SHORTEST_SEC));
      return fit ? fit.at : Infinity;
    };

    if (jumps.length) {
      let best = [];
      let bestTarget = Infinity;
      for (const { target } of jumps) {
        const group = jumps.filter(j => Math.abs(j.target - target) <= OP_GROUP_SEC);
        if (group.length > best.length || (group.length === best.length && target < bestTarget)) {
          best = group;
          bestTarget = target;
        }
      }
      const targets = best.map(j => j.target).sort((a, b) => a - b);
      const target = targets[Math.floor((targets.length - 1) / 2)];
      return {
        start: snapStart(Math.min(...best.map(j => j.sec), startBefore(target))),
        end: target - OP_JUMP_EARLY_SEC,
        source: 'jump',
        votes: best.length,
      };
    }

    if (film) return null;

    const land = busiestWindow(landed);
    if (land && land.at >= OP_MIN_SEC) {
      const clue = startBefore(land.at);
      return {
        start: snapStart(clue < Infinity ? clue : land.at - OP_DEFAULT_SEC),
        end: land.at,
        source: clue < Infinity ? 'landed+start' : 'landed',
        votes: land.count,
      };
    }

    if (openings.length >= OP_OPENING_MIN) {
      return { start: 0, end: OP_DEFAULT_SEC, source: 'opening', votes: openings.length };
    }

    const greet = busiestWindow(greets);
    if (greet && greet.count >= OP_GREET_MIN) {
      // A plain "OP!" often comes a moment before the first "op君".
      const start = snapStart(Math.min(...talk.filter(t => t >= greet.at - OP_WINDOW_SEC), greet.at));
      if (start + OP_DEFAULT_SEC < duration) {
        return { start, end: start + OP_DEFAULT_SEC, source: 'greet', votes: greet.count };
      }
    }

    const burst = busiestWindow(talk, OP_DEFAULT_SEC);
    if (burst && burst.count >= OP_TALK_MIN) {
      const start = snapStart(burst.at);
      if (start + OP_DEFAULT_SEC < duration) {
        return { start, end: start + OP_DEFAULT_SEC, source: 'talk', votes: burst.count };
      }
    }
    return null;
  }
}

function snapStart(sec) {
  return sec < OP_START_SNAP_SEC ? 0 : sec;
}

// The earliest of the `window`-second windows with the most times in
// them: { at: its first time, count }, or null for no times.
function busiestWindow(times, window = OP_WINDOW_SEC) {
  times = [...times].sort((a, b) => a - b);
  let best = null;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[j] < times[i] - window) j++;
    if (!best || i - j + 1 > best.count) best = { at: times[j], count: i - j + 1 };
  }
  return best;
}

// A clicked button that hides (or a dialog that closes) drops focus to
// <body>, but the official hotkeys (←/→ to seek, space, ...) listen on the
// player element: give it focus back. opreport.js uses this too.
function opFocusPlayer(player) {
  if (!player.hasAttribute('tabindex')) player.tabIndex = -1;
  player.focus({ preventScroll: true });
}

// getAudio: the OP found from the sound (opaudio.js), preferred over the
// danmaku guess.
function initOpSkip({ video, player, getDanmaku, getVideoSn, getAudio, isEnabled, keepReview = () => false, log }) {
  let opening = null;
  let found = null;
  let logged = '';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dmk-op-skip';
  button.hidden = true;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!opening) return;
    log('opSkip', { from: Math.round(video.currentTime), to: opening.end });
    video.currentTime = opening.end;
    button.hidden = true;
    opFocusPlayer(player);
  });

  function update() {
    const duration = video.duration;
    const episode = Number.isFinite(duration) && duration >= OP_MIN_VIDEO_SEC;
    const list = getDanmaku();
    // Empty while an in-place episode change loads the new list.
    const film = duration >= OP_FILM_MIN_SEC || OP_FILM_TITLE_RE.test(document.title);
    const guess = episode && list.length ? findOpening(list, duration, film) : null;
    const audio = episode ? getAudio() : null;
    found = audio
      ? { start: audio.start, end: audio.end, source: audio.source, ...(guess ? { clues: guess.clues } : {}) }
      : guess;
    opening = found && found.end !== undefined ? found : null;
    const sn = getVideoSn();
    const key = `${sn} ${JSON.stringify(found)}`;
    if (found && key !== logged) {
      logged = key;
      log('opening', found);
      if (keepReview()) {
        keepForReview(sn, found, list, duration)
          .catch(err => console.warn('[Danmaku Enhancer] OP review write failed:', err));
      }
    }
    if (opening) {
      button.textContent = DmkI18n.t('player.skipOp');
      button.title = DmkI18n.t('player.skipOpTitle', { time: formatOpTime(opening.end) });
    }
    if (button.parentNode !== player) player.appendChild(button);
    sync();
  }

  // Shows the button only inside the OP, outside ads.
  function sync() {
    const t = video.currentTime;
    button.hidden = !(isEnabled() && opening && t >= opening.start && t < opening.end - 1 &&
      !player.classList.contains('vjs-ad-playing'));
  }

  video.addEventListener('timeupdate', sync);
  video.addEventListener('seeked', sync);
  video.addEventListener('durationchange', update);
  video.addEventListener('loadedmetadata', update);

  return {
    update,
    // For the density curve's start and end ticks.
    range: () => (isEnabled() ? opening : null),
    // The latest guess for this episode, also 'none' or 'unknown' (for reports).
    result: () => found,
  };
}

async function keepForReview(sn, found, list, duration) {
  const { [OP_REVIEW_STORE]: all = {} } = await chrome.storage.local.get(OP_REVIEW_STORE);
  if (found.source !== 'unknown') {
    if (!all[sn]) return;
    delete all[sn];
  } else {
    all[sn] = {
      url: `https://ani.gamer.com.tw/animeVideo.php?sn=${sn}`,
      title: document.title.replace(/\s*線上看.*$/, ''),
      at: new Date().toISOString(),
      duration: Math.round(duration),
      comments: list.length,
      clues: found.clues,
      samples: list
        .filter(d => OP_SAMPLE_RE.test(String(d.text || '').normalize('NFKC')))
        .slice(0, OP_REVIEW_SAMPLES)
        .map(d => [d.time / 10, d.text]),
    };
    const newest = Object.keys(all).sort((a, b) => all[b].at.localeCompare(all[a].at));
    for (const old of newest.slice(OP_REVIEW_MAX)) delete all[old];
  }
  await chrome.storage.local.set({ [OP_REVIEW_STORE]: all });
}

function formatOpTime(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
