# Bahamut Danmaku Enhancer

A powerful Chrome Extension designed to overhaul the native danmaku (bullet comment) system on Bahamut Anime Crazy (巴哈姆特動畫瘋). It bypasses native limitations and introduces a robust, multi-layered filtering system powered by Chrome's built-in Gemini Nano AI.

## Core Features

### 1. Unlimited Danmaku Overlay Engine
- **Bypass the 3000-Item Limit**: The native player caps comments at 3000, causing early comments on popular videos to be completely hidden. This extension pre-fetches the entire JSON response and streams *all* comments cleanly without limits.
- **Custom Hardware-Accelerated Engine**: Injects our own overlay inside the native `.vjs-danmu` area and hides the native comments (`.danmu-warp`), so both always cover the same area.
- **Matches the Official Player**: Ports the official renderer — font sizes, rolling speed and duration, top/bottom comments, pixel-based placement — and follows the official settings (danmaku on/off, opacity, size, rolling/top/bottom toggles, TW/HK sources) live.

### 2. Multi-Layer Hybrid Filtering System
To maintain perfect video performance while evaluating thousands of comments, the filtering engine works in two passes:

- **Pass 1: Instant Fast-Filter (Blocklists)**
  - Instantly blocks comments originating from blocked User IDs.
  - Instantly blocks comments containing blocked keywords.
  - **Webpage Integration**: Automatically reads your keyword filters from Bahamut's "進階設定" panel (server-rendered in the page) and follows them as you add or delete keywords.
  
- **Pass 2: AI Semantic Filtering (Gemini Nano)**
  - Uses a Just-In-Time (JIT) batching strategy. A few seconds before a comment appears on-screen, it is passed to Chrome's built-in local `aiOriginTrial.languageModel`.
  - The AI evaluates the semantics of the comment to catch *spoilers (劇透)*, *inappropriate sexual intent*, and *toxic behavior*, including comments that try to evade standard filters using similar phonetics or symbols.

### 3. Interactive Danmaku Context Modal
- **Click to Pause & Inspect**: Clicking on any moving danmaku instantly pauses the video and opens a beautifully styled modal.
- **Contextual Actions**: From the modal, you can see the comment's timestamp and author ID, and you have one-click buttons to:
  - **Copy** the text.
  - **Block User** (Instantly purges all their comments from the screen).
  - **Filter Text** (Instantly adds the phrase to your blocklist).
- **Adaptive Design**: The modal supports automatic Light/Dark mode themes based on your system preferences.

### 4. Extension Popup Manager
A clean, lightweight popup UI (`popup.html`) allowing you to:
- Toggle the AI semantic filter on or off.
- Manage your custom Keyword Blocklist.
- Manage your User ID Blocklist.

### 5. Historical Versioning & Eviction Protection System
- **Long-term Danmaku Preservation**: Bahamut's servers impose rolling upper limits where newly added comments push out older, classic ones (such as high-effort lyrics, song translations, and key scene annotations).
- **Automated Snapshotting & Diffs**: The `backup_danmaku.py` engine takes point-in-time snapshots, detects newly evicted comments (`-M`) vs newly added comments (`+N`), and maintains a lossless cumulative master database.
- **Player Subtitle Generation (ASS)**: Automatically compiles active, evicted, and lyric comments into styled `.ass` subtitle files ready for local media players (IINA, mpv, VLC).

### 6. Scene Bookmarks (Best-Scene Collection)
- **Save a moment or a clip while watching**: hover the player for the toolbar in the top-right corner, or use the keyboard — `B` saves the current moment, `[` marks a clip's start and `]` its end (`Esc` cancels). Shortcuts are ignored while typing in any input.
- **Captured automatically**: work and episode title, a thumbnail of the current frame (falling back to the anime cover), and up to 30 danmaku from around the scene.
- **In-player list**: the toolbar's list button shows this episode's bookmarks — click one to jump there. Clips play back and pause at their end, with a *Replay* option.
- **Bookmark Manager** (`bookmarks/manager.html`, opened from the popup or the in-player list): scenes grouped by work, full-text search (titles, notes, tags, danmaku), Moment/Clip and tag filters, editing of title/note/tags/start/end, delete with undo, and JSON export/import for backup or moving to another browser.
- **Play from the manager**: reuses an already-open tab of that episode and seeks in place; otherwise opens a deep link (`animeVideo.php?sn=…#dmk=start-end`) that seeks once the episode has loaded.

## Architecture

- **`manifest.json`**: MV3 architecture utilizing `service_worker` for background processing.
- **`background.js`**: Maintains the persistent session with the Prompt API (`LanguageModel`) for Pass-2 filtering, and hosts bookmark storage.
- **`content.js`**: Fetches the danmaku list, hooks into the video player, runs the render loop synchronized to `videoElement.currentTime`, reads the official settings (`ANIME_danmu*` in `localStorage`) and keyword list, and handles click events.
- **`content.css`**: Hides the native comments, styles our comments like the official ones, and provides the light/dark mode UI for the contextual modal.
- **`ROADMAP.md`**: Phases, measured facts about the official player and API, and the planned danmaku search feature.
- **`bookmarks/`**: Scene bookmarks. `common.js` holds helpers shared by every context; `store.js` (imported by `background.js`) is the single writer to `chrome.storage.local`, which serializes updates from the page and the manager; `content-bookmarks.js`/`.css` is the in-player toolbar, panel and quick editor; `manager.html`/`.js`/`.css` is the full-page manager.
- **`backup_danmaku.py`**: Standalone multi-versioning archival tool that tracks comment lifecycles, lyric annotations, and rolling evictions.

## Installation for Development

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked** and select the directory containing this repository.
4. Navigate to any Bahamut Anime Crazy video (e.g., `https://ani.gamer.com.tw/animeVideo.php?sn=19849`) to see it in action.

## CLI Danmaku Archival & Versioning Tool

To backup and version comments for any anime:

```bash
# Backup/update by video SN or full URL
python3 backup_danmaku.py 12331
# or
python3 backup_danmaku.py "https://ani.gamer.com.tw/animeVideo.php?sn=12331"
```

