// infomode.js
//
// Info mode (資訊彈幕, settings.infoMode): finds the comments that add
// information, so content.js can show them at full opacity and dim the
// rest to INFO_DIM of the official opacity. All local; nothing is sent.
//
// - Lyrics: lyric runs (opskip.js lyricScript / lyricRun and its LYRIC_*
//   limits) anywhere in the video: the OP, insert songs and the ED. A user
//   with more than one run before the last LYRIC_ED_SEC posts the Japanese
//   dialogue ('transcript'), which is shown too. Lines by other users at
//   the same moments (INFO_PARALLEL_MIN or more) are a translation and
//   join the block.
// - Notes: one user's parts posted within INFO_SPLIT_SEC of each other, or
//   one comment that names a source (INFO_SOURCE_RE), kept when
//   infoNoteScore() reaches INFO_NOTE_MIN_SCORE: placed top or bottom,
//   colored, marker words (科普, 冷知識, 趣聞, 設定集, …), long; minus
//   opinion words, swearing and questions. Viewers often split an argument
//   into parts too; the score keeps those out.
// - Floods (laughs, symbols, chants such as 熬夜熬夜熬夜, dates and
//   check-ins) are never informative.
// Spoilers are not filtered yet. The same rules, with a command-line view
// of the blocks, were tried first on cached episodes.

const INFO_DIM = 0.25;
const INFO_PARALLEL_SEC = 1;
const INFO_PARALLEL_MIN = 4;
const INFO_SPLIT_SEC = 3;
const INFO_SPLIT_MIN_CHARS = 20;
const INFO_SINGLE_MIN_CHARS = 8;
const INFO_LONG_CHARS = 30;
const INFO_NOTE_MIN_SCORE = 3;
const INFO_CHECKIN_MAX_CHARS = 25;
const INFO_SOURCE_RE = /小說|小说|原作|原著|漫畫|漫画|web版|書裡|书里|設定|设定|補充|补充|科普|冷知識|翻譯|翻译|原文|彩蛋|致敬|典故/;
const INFO_MARKER_RE = /科普|冷知識|冷知识|小知識|小知识|趣聞|趣闻|補充|补充|註:|注:|ps:|設定集|设定集|翻譯:|翻译:|原文:/i;
const INFO_OPINION_RE = /我覺得|我觉得|笑死|好笑|討厭|讨厌|垃圾|白癡|白痴|智障|腦殘|脑残|父權|父权|政治|噁心|恶心|好爛|好烂/;
const INFO_SWEAR_RE = /幹|干你|靠北|靠腰|雞掰|鸡掰|媽的|妈的|傻[bB逼]|尻/;
const INFO_QUESTION_RE = /[?？]\s*$|[嗎吗呢]\s*$/;
// Unicode classes: in JS, \w and \W cover only ASCII, so they would treat
// every Chinese text as symbols.
const INFO_FLOOD_RE = /^[\s\p{P}\p{S}_wｗ哈呵草XxDd笑]*$/u;
const INFO_REPEAT_RE = /([\p{L}\p{N}_]{1,4})\1{2,}/u;
const INFO_CHECKIN_RE = /(?:19|20)\d{2}\s*[/.\-年]\s*\d{1,2}|簽到|签到|留名|到此一遊|到此一游|打卡|完結[灑撒]花|完结[洒撒]花/;

// { sns: Set of informative comment sn, blocks: [{ type, start, end, count }] }
function findInfoComments(list, duration) {
  const text = new Map(list.map(d => [d, String(d.text || '').normalize('NFKC').trim().replace(/\s*\n\s*/g, ' ⏎ ')]));
  const sns = new Set();
  const blocks = [];
  const add = (type, items) => {
    items.forEach(d => sns.add(d.sn));
    blocks.push({ type, start: items[0].time / 10, end: items[items.length - 1].time / 10, count: items.length });
  };

  // Lyrics and transcripts.
  const byUser = new Map();
  for (const d of list) {
    if (!d.position || !d.userid || !lyricScript(text.get(d))) continue;
    if (!byUser.has(d.userid)) byUser.set(d.userid, []);
    byUser.get(d.userid).push(d);
  }
  const runs = [];
  for (const [user, items] of byUser) {
    items.sort((a, b) => a.time - b.time);
    const found = [];
    let run = [];
    for (const d of [...items, null]) {
      if (run.length && (!d || (d.time - run[run.length - 1].time) / 10 > LYRIC_GAP_MAX_SEC)) {
        if (lyricRun(run.map(x => ({ sec: x.time / 10, text: text.get(x) })))) found.push(run);
        run = [];
      }
      if (d) run.push(d);
    }
    const beforeEd = found.filter(r => r[0].time / 10 < duration - LYRIC_ED_SEC).length;
    for (const r of found) runs.push({ user, type: beforeEd > 1 ? 'transcript' : 'lyrics', items: r });
  }
  runs.forEach(r => r.items.forEach(d => sns.add(d.sn)));
  for (const r of runs) {
    if (r.type === 'lyrics') {
      // Another user's lines at the same moments: a translation.
      const stamps = r.items.map(d => d.time);
      const near = new Map();
      for (const d of list) {
        if (sns.has(d.sn) || !d.position || d.userid === r.user || infoFlood(text.get(d))) continue;
        if (!stamps.some(t => Math.abs(d.time - t) <= INFO_PARALLEL_SEC * 10)) continue;
        if (!near.has(d.userid)) near.set(d.userid, []);
        near.get(d.userid).push(d);
      }
      for (const items of near.values()) {
        if (items.length >= INFO_PARALLEL_MIN) r.items.push(...items);
      }
      r.items.sort((a, b) => a.time - b.time);
    }
    add(r.type, r.items);
  }

  // Notes.
  const notes = new Map();
  for (const d of list) {
    if (sns.has(d.sn) || infoFlood(text.get(d))) continue;
    if (!notes.has(d.userid)) notes.set(d.userid, []);
    notes.get(d.userid).push(d);
  }
  for (const items of notes.values()) {
    items.sort((a, b) => a.time - b.time);
    let group = [];
    for (const d of [...items, null]) {
      if (group.length && (!d || (d.time - group[group.length - 1].time) / 10 > INFO_SPLIT_SEC)) {
        const texts = group.map(x => text.get(x));
        const chars = texts.reduce((n, t) => n + t.length, 0);
        const source = texts.some(t => INFO_SOURCE_RE.test(t));
        const split = group.length >= 2 && new Set(texts).size === texts.length && chars >= INFO_SPLIT_MIN_CHARS;
        if ((split || (source && chars >= INFO_SINGLE_MIN_CHARS)) &&
            infoNoteScore(group, texts, chars, source) >= INFO_NOTE_MIN_SCORE) {
          add('note', group);
        }
        group = [];
      }
      if (d) group.push(d);
    }
  }
  return { sns, blocks };
}

function infoFlood(text) {
  if (INFO_FLOOD_RE.test(text) || INFO_REPEAT_RE.test(text)) return true;
  if (text.length <= INFO_CHECKIN_MAX_CHARS && INFO_CHECKIN_RE.test(text)) return true;
  return text.length >= 6 && new Set(text).size / text.length < 0.4;
}

// How much a message looks like information rather than opinion.
function infoNoteScore(group, texts, chars, source) {
  let score = 0;
  if (group.some(d => d.position)) score += 2;      // top/bottom: placed on purpose
  if (group.some(d => String(d.color || '').toUpperCase() !== '#FFFFFF')) score += 1;
  if (texts.some(t => INFO_MARKER_RE.test(t))) score += 2;
  if (source) score += 1;
  if (chars >= INFO_LONG_CHARS) score += 1;
  if (group.length >= 3) score += 1;
  if (texts.some(t => INFO_OPINION_RE.test(t))) score -= 2;
  if (texts.some(t => INFO_SWEAR_RE.test(t))) score -= 3;
  if (texts.some(t => INFO_QUESTION_RE.test(t))) score -= 1;
  return score;
}
