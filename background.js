// background.js

// Initialize default settings on install
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

let aiSession = null;

// Helper to initialize or get AI session
async function getAiSession() {
  if (aiSession) return aiSession;
  
  // Try to use chrome.languageModel (newer) or self.aiOriginTrial.languageModel
  const modelApi = chrome.languageModel || (self.aiOriginTrial && self.aiOriginTrial.languageModel);
  
  if (!modelApi) {
    console.warn("AI Prompt API is not available.");
    return null;
  }
  
  try {
    const capabilities = await modelApi.capabilities();
    if (capabilities.available === 'no') {
      console.warn("AI model is not available.");
      return null;
    }
    
    // Create session with system prompt for moderation
    aiSession = await modelApi.create({
      systemPrompt: "You are a content moderator for an anime streaming platform. " +
        "Your job is to determine if a user comment (danmaku) contains spoilers, inappropriate sexual intent/innuendo, or extreme toxicity. " +
        "Reply with exactly 'BLOCK' if it contains any of these, or 'ALLOW' if it is safe. Do not explain your reasoning."
    });
    return aiSession;
  } catch (err) {
    console.error("Failed to create AI session:", err);
    return null;
  }
}

// Evaluate a single comment using AI
async function evaluateCommentWithAi(text) {
  const session = await getAiSession();
  if (!session) return true; // Allow if AI is unavailable
  
  try {
    const result = await session.prompt(`Comment: "${text}"`);
    return !result.toUpperCase().includes('BLOCK');
  } catch (err) {
    console.error("AI Evaluation failed:", err);
    return true; // Fallback to allowing
  }
}

// Message Router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_DANMAKU') {
    (async () => {
      try {
        const url = `https://api.gamer.com.tw/anime/v1/danmu.php?videoSn=${message.videoSn}&geo=TW%2CHK`;
        const res = await fetch(url);
        const data = await res.json();
        sendResponse({ success: true, data: data });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open
  }
  
  if (message.type === 'AI_FILTER_BATCH') {
    (async () => {
      const results = [];
      for (const danmaku of message.batch) {
        // Only evaluate if text exists and is long enough to warrant AI check (heuristic)
        if (danmaku.text && danmaku.text.length > 2) {
          const isAllowed = await evaluateCommentWithAi(danmaku.text);
          results.push({ sn: danmaku.sn, allowed: isAllowed });
        } else {
          results.push({ sn: danmaku.sn, allowed: true });
        }
      }
      sendResponse({ success: true, results });
    })();
    return true; // Keep channel open
  }
});
