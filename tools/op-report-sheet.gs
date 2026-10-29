// op-report-sheet.gs
//
// Google Apps Script web app that receives wrong-OP reports from the
// extension (opreport.js -> background.js) and adds one row per report to
// a Google Sheet. A report is one click: the guess, the video time of the
// click and the viewer's last seeks ("seeks": "from→to; …" in seconds; a
// jump back after a wrong skip shows where the OP really ends).
//
// Set up:
// 1. Create a Google Sheet. Open Extensions > Apps Script.
// 2. Replace Code.gs with this file. Save.
// 3. Run setup() once from the editor and allow access to the sheet.
// 4. Deploy > New deployment > Web app. Execute as: Me. Who has access:
//    Anyone.
// 5. Copy the web app URL (ends in /exec) into OP_REPORT_URL in
//    background.js.
// After a code change here, use Deploy > Manage deployments > Edit > New
// version, so the URL stays the same.
//
// The URL is public (it is in the extension code), so anyone can post to
// it. Each field is checked against a fixed list or range, at most
// MAX_PER_MINUTE rows are added per minute, and the same report again
// within SAME_REPORT_SEC is dropped. Apps Script does not give the sender's
// IP address to the script, so the sheet holds no address.

const SHEET_NAME = 'reports';
const HEADER = ['received', 'sn', 'url', 'at', 'duration',
  'guess_source', 'guess_start', 'guess_end', 'seeks', 'ext'];
const MAX_SEEKS = 5;
const SOURCES = ['jump', 'landed', 'landed+start', 'opening', 'greet', 'talk', 'none', 'unknown'];
const MAX_VIDEO_SEC = 4 * 60 * 60;
const MAX_PER_MINUTE = 30;
const SAME_REPORT_SEC = 600;

function setup() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName(SHEET_NAME) || book.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
    sheet.setFrozenRows(1);
  }
}

function doGet() {
  return reply({ ok: true, service: 'op-report' });
}

function doPost(e) {
  let report;
  try {
    report = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'bad json' });
  }
  const row = toRow(report);
  if (!row) return reply({ ok: false, error: 'bad report' });

  const cache = CacheService.getScriptCache();
  const same = ['r', report.sn, Math.round(report.at)].join(':');
  if (cache.get(same)) return reply({ ok: true, duplicate: true });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return reply({ ok: false, error: 'busy' });
  try {
    const minute = 'm:' + Math.floor(Date.now() / 60000);
    const count = Number(cache.get(minute) || 0);
    if (count >= MAX_PER_MINUTE) return reply({ ok: false, error: 'too many reports, try later' });
    cache.put(minute, String(count + 1), 120);
    sheet().appendRow(row);
    cache.put(same, '1', SAME_REPORT_SEC);
  } finally {
    lock.releaseLock();
  }
  return reply({ ok: true });
}

// The row for a valid report, or null. Only numbers and strings from the
// fixed lists go into the sheet, so a cell can never hold a formula.
function toRow(r) {
  if (!r || typeof r !== 'object' || r.v !== 2) return null;
  if (!Number.isInteger(r.sn) || r.sn <= 0 || r.sn > 1e8) return null;
  if (!inRange(r.at, 0, MAX_VIDEO_SEC) || !inRange(r.duration, 0, MAX_VIDEO_SEC)) return null;
  if (typeof r.ext !== 'string' || !/^\d{1,4}(\.\d{1,5}){0,3}$/.test(r.ext)) return null;
  let source = '';
  let start = '';
  let end = '';
  if (r.guess !== null) {
    const g = r.guess;
    if (!g || typeof g !== 'object' || SOURCES.indexOf(g.source) < 0) return null;
    if (g.start !== null && !inRange(g.start, 0, MAX_VIDEO_SEC)) return null;
    if (g.end !== null && !inRange(g.end, 0, MAX_VIDEO_SEC)) return null;
    source = g.source;
    start = g.start === null ? '' : g.start;
    end = g.end === null ? '' : g.end;
  }
  if (!Array.isArray(r.seeks) || r.seeks.length > MAX_SEEKS) return null;
  for (const s of r.seeks) {
    if (!Array.isArray(s) || s.length !== 2 ||
        !inRange(s[0], 0, MAX_VIDEO_SEC) || !inRange(s[1], 0, MAX_VIDEO_SEC)) return null;
  }
  const seeks = r.seeks.map(s => s[0] + '→' + s[1]).join('; ');
  return [new Date(), r.sn, 'https://ani.gamer.com.tw/animeVideo.php?sn=' + r.sn,
    r.at, r.duration, source, start, end, seeks, r.ext];
}

function inRange(n, min, max) {
  return typeof n === 'number' && isFinite(n) && n >= min && n <= max;
}

function sheet() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  return book.getSheetByName(SHEET_NAME) || (setup(), book.getSheetByName(SHEET_NAME));
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
