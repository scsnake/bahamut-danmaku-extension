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
        aiFilterEnabled: true,
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

function dlog(event, data) {
  console.log("[Danmaku Enhancer]", event, data === undefined ? '' : data);
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DEBUG_LOG') {
    appendDebugLog(message.entries || []);
    return false;
  }

  if (message.type === 'AI_FILTER_BATCH') {
    (async () => {
      try {
        // Evaluate in parallel — cloned sessions in evaluateCommentWithAi
        // keep state clean.
        const results = await Promise.all(message.batch.map(async (danmaku) => {
          if (!danmaku.text || danmaku.text.length <= 2) {
            return { sn: danmaku.sn, allowed: true };
          }
          const allowed = await evaluateCommentWithAi(danmaku.text);
          return { sn: danmaku.sn, allowed };
        }));
        sendResponse({ success: true, results });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});
