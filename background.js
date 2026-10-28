// background.js

// Scene bookmark storage (BOOKMARK_* messages).
importScripts('bookmarks/common.js', 'bookmarks/store.js');

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) {
    await chrome.storage.local.set({
      settings: {
        aiFilterEnabled: true,
        aiStrictness: 'moderate', // 'low', 'moderate', 'high'
        keywordBlocklist: [],
        userBlocklist: []
      }
    });
  }
});

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
    const candidates = [
      self.LanguageModel,
      self.ai && self.ai.languageModel,
      chrome.languageModel,
      self.aiOriginTrial && self.aiOriginTrial.languageModel
    ].filter(Boolean);

    if (candidates.length === 0) {
      console.warn("[Danmaku Enhancer] AI Prompt API is not available.");
      return null;
    }

    for (const modelApi of candidates) {
      try {
        let available = true;
        if (typeof modelApi.availability === 'function') {
          const status = await modelApi.availability();
          available = status !== 'no' && status !== 'unavailable';
        } else if (typeof modelApi.capabilities === 'function') {
          const caps = await modelApi.capabilities();
          available = caps.available !== 'no';
        }
        if (!available) continue;

        // Send both `initialPrompts` (current API) and `systemPrompt` (legacy);
        // implementations ignore what they don't recognize.
        const session = await modelApi.create({
          initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
          systemPrompt: SYSTEM_PROMPT
        });
        aiSession = session;
        return session;
      } catch (err) {
        console.warn("[Danmaku Enhancer] AI session creation failed on candidate:", err);
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
    console.error("[Danmaku Enhancer] AI Evaluation failed:", err);
    return true;
  } finally {
    if (cloned && typeof session.destroy === 'function') {
      try { session.destroy(); } catch (_) {}
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_DANMAKU') {
    (async () => {
      try {
        const url = `https://api.gamer.com.tw/anime/v1/danmu.php?videoSn=${encodeURIComponent(message.videoSn)}&geo=TW%2CHK`;
        // credentials: 'include' so the request carries the user's gamer.com.tw
        // cookies (needed for personalized filter state on the server side).
        const res = await fetch(url, { credentials: 'include' });
        const data = await res.json();
        sendResponse({ success: true, data });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
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
