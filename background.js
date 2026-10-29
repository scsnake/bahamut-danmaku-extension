// background.js

// Scene bookmark storage (BOOKMARK_* messages).
importScripts('bookmarks/common.js', 'bookmarks/store.js');

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) {
    await chrome.storage.local.set({
      settings: {
        overlayEnabled: true,
        densityEnabled: true,
        liveUpdate: true,
        infoMode: false,
        autoAgreeAgeGate: true,
        opAudio: true,
        audioProbe: false,
        debugMode: false,
        aiFilterEnabled: false,
        aiStrictness: 'moderate', // 'low', 'moderate', 'high'
        keywordBlocklist: [],
        userBlocklist: []
      }
    });
  }
});

// Debug log shared by all tabs (DEBUG_LOG messages) and this worker. Kept in
// chrome.storage.local, newest DEBUG_LOG_MAX entries; exported from the popup.
const DEBUG_LOG_MAX = 5000;
let debugWrite = Promise.resolve();

function appendDebugLog(entries) {
  debugWrite = debugWrite.then(async () => {
    const { debugLog = [] } = await chrome.storage.local.get("debugLog");
    debugLog.push(...entries);
    await chrome.storage.local.set({ debugLog: debugLog.slice(-DEBUG_LOG_MAX) });
  }).catch(err => console.warn("[Danmaku Enhancer] Debug log write failed:", err));
}

// Full logging is for development (settings.debugMode); otherwise only
// errors are kept, here and in the content script.
let debugMode = false;
chrome.storage.local.get('settings').then(({ settings }) => {
  debugMode = !!(settings && settings.debugMode);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    debugMode = !!(changes.settings.newValue && changes.settings.newValue.debugMode);
  }
});

function dlog(event, data) {
  const error = /error|failed/i.test(event) || (!!data && data.ok === false);
  if (!error && !debugMode) return;
  (error ? console.warn : console.log)("[Danmaku Enhancer]", event, data === undefined ? '' : data);
  appendDebugLog([{ t: new Date().toISOString(), src: 'background', event, data }]);
}

const SYSTEM_PROMPT =
  "You are a content moderator for an anime streaming platform. " +
  "Your job is to determine if a user comment (danmaku) contains spoilers, " +
  "inappropriate sexual intent/innuendo, or extreme toxicity. " +
  "Reply with exactly 'BLOCK' if it contains any of these, or 'ALLOW' if it is safe. " +
  "Do not explain your reasoning.";

let aiSession = null;

let aiSessionPromise = null;

// Helper to initialize or get AI session
async function getAiSession() {
  if (aiSession) return aiSession;
  if (aiSessionPromise) return await aiSessionPromise;

  aiSessionPromise = (async () => {
    const named = [
      ['LanguageModel', self.LanguageModel],
      ['ai.languageModel', self.ai && self.ai.languageModel],
      ['chrome.languageModel', chrome.languageModel],
      ['aiOriginTrial.languageModel', self.aiOriginTrial && self.aiOriginTrial.languageModel]
    ];
    const candidates = named.filter(([, api]) => api);
    dlog('aiApis', { defined: candidates.map(([name]) => name) });

    if (candidates.length === 0) return null;

    for (const [name, modelApi] of candidates) {
      try {
        let available = true;
        let status = null;
        if (typeof modelApi.availability === 'function') {
          status = await modelApi.availability();
          available = status !== 'no' && status !== 'unavailable';
        } else if (typeof modelApi.capabilities === 'function') {
          const caps = await modelApi.capabilities();
          status = caps.available;
          available = caps.available !== 'no';
        }
        dlog('aiAvailability', { api: name, status });
        if (!available) continue;

        // Send both `initialPrompts` (current API) and `systemPrompt` (legacy);
        // implementations ignore what they don't recognize.
        const started = Date.now();
        const session = await modelApi.create({
          initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
          systemPrompt: SYSTEM_PROMPT
        });
        dlog('aiSession', { api: name, createMs: Date.now() - started, clone: typeof session.clone === 'function' });
        aiSession = session;
        return session;
      } catch (err) {
        dlog('aiSessionFailed', { api: name, message: String(err && err.message || err) });
      }
    }
    return null;
  })();

  try {
    return await aiSessionPromise;
  } finally {
    aiSessionPromise = null;
  }
}

async function evaluateCommentWithAi(text) {
  const base = await getAiSession();
  if (!base) return true; // Allow if AI is unavailable.

  // Clone per-call when supported so conversation history doesn't grow across
  // classifications (each danmaku should be a stateless yes/no).
  let session = base;
  let cloned = false;
  if (typeof base.clone === 'function') {
    try {
      session = await base.clone();
      cloned = true;
    } catch (_) {
      session = base;
    }
  }

  try {
    const result = await session.prompt(`Comment: "${text}"`);
    return !String(result).toUpperCase().includes('BLOCK');
  } catch (err) {
    dlog('aiPromptFailed', { message: String(err && err.message || err) });
    return true;
  } finally {
    if (cloned && typeof session.destroy === 'function') {
      try { session.destroy(); } catch (_) {}
    }
  }
}

// Wrong-OP reports (opreport.js). The Google Apps Script web app that adds
// each report to the developer's sheet ("https://script.google.com/macros/s/.../exec");
// empty turns reporting off and hides the report button.
const OP_REPORT_URL = 'https://script.google.com/macros/s/AKfycbxviWoy1RrAqjQuYxS-Ghk0yrQgLLfPG6VDErqhJ7hXa2dUqyLdjH2eEcROz3K0hqN3eA/exec';
const OP_REPORT_TIMEOUT_MS = 15000;

// Builds the request from the listed fields only, so nothing else from the
// page can be sent.
async function sendOpReport(r) {
  if (!OP_REPORT_URL) return { ok: false, error: 'not configured' };
  const num = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  const g = r && r.guess;
  const seeks = Array.isArray(r && r.seeks) ? r.seeks : [];
  const body = {
    v: 2,
    sn: Number.isInteger(r && r.sn) ? r.sn : null,
    at: num(r && r.at),
    duration: num(r && r.duration),
    guess: g ? { source: String(g.source || ''), start: num(g.start), end: num(g.end) } : null,
    seeks: seeks.slice(-5).map(s => [num(s && s[0]), num(s && s[1])]),
    ext: chrome.runtime.getManifest().version,
  };
  // text/plain keeps it a simple request (no CORS preflight, which Apps
  // Script does not answer).
  const res = await fetch(OP_REPORT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    credentials: 'omit',
    signal: AbortSignal.timeout(OP_REPORT_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const reply = await res.json().catch(() => null);
  return reply && reply.ok ? { ok: true } : { ok: false, error: (reply && reply.error) || 'bad reply' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DEBUG_LOG') {
    appendDebugLog(message.entries || []);
    return false;
  }

  if (message.type === 'OPEN_PRIVACY') {
    chrome.tabs.create({ url: chrome.runtime.getURL('privacy/privacy.html') });
    return false;
  }

  if (message.type === 'OP_REPORT_READY') {
    sendResponse({ ready: !!OP_REPORT_URL });
    return false;
  }

  if (message.type === 'OP_REPORT') {
    sendOpReport(message.report)
      .then(res => {
        dlog('opReportSent', { sn: message.report && message.report.sn, ok: res.ok, error: res.error });
        sendResponse(res);
      })
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (message.type === 'AI_FILTER_BATCH') {
    (async () => {
      try {
        // One text at a time: parallel prompts were not faster, and the
        // content script orders the texts soonest first.
        const results = [];
        for (const text of message.texts || []) {
          results.push({ text, allowed: await evaluateCommentWithAi(text) });
        }
        sendResponse({ success: true, results });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});
