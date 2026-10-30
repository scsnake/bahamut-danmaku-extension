# Danmaku Enhancer for AniGamer (Unofficial)

彈幕增強 for 動畫瘋（非官方）. An unofficial personal project: it is not made by or connected to Bahamut (巴哈姆特).

A powerful Chrome Extension designed to overhaul the native danmaku (bullet comment) system on Bahamut Anime Crazy (巴哈姆特動畫瘋). It bypasses native limitations and introduces a robust, multi-layered filtering system. An AI filter on Chrome's built-in Gemini Nano is in the code but turned off until it is tested.

## Core Features

### 1. Unlimited Danmaku Overlay Engine
- **Same Comment List as the Official Player**: Uses the same `danmu.php` request, with your cookies, so any filtering Bahamut does for your account still applies. Your official keyword filters also apply in the layer itself (see Webpage Integration). The native player has no 3000-comment display cap (it only labels counts above 3000 as "3000+"); an episode with 3001 comments renders all 3001 in both layers.
- **Custom Hardware-Accelerated Engine**: Injects our own overlay inside the native `.vjs-danmu` area and hides the native comments (`.danmu-warp`), so both always cover the same area.
- **Matches the Official Player**: Ports the official renderer — font sizes, rolling speed and duration, top/bottom comments, pixel-based placement — and follows the official settings (danmaku on/off, opacity, size, rolling/top/bottom toggles, TW/HK sources) live.
- **Live Updates**: While you watch, the list is fetched again every 2 minutes, so comments other viewers just sent show up. A comment you send shows within a few seconds (our layer hides the official one, which would show it at once). Can be turned off in the popup.
- **Info Danmaku Mode**: Off by default (popup). Comments that carry information stay fully visible and the others fade to a quarter of the official opacity. Informative comments are lyric runs (one user's Japanese or romaji lines at a song's rhythm, with another user's lines at the same moments as their translation), a user's transcript of the Japanese dialogue, and notes: one user's message in parts within 3 s, or one comment that names a source (原作, 小說, 設定, 科普, …), scored up for top/bottom placement, color, marker words and length, and down for opinion words, swearing and questions. Laughs, symbol floods, chants, dates and check-ins never count. Usually 0.5–3% of the comments qualify. Everything runs locally; spoilers are not filtered yet.
- **Danmaku Density Curve**: A faint curve just above the progress bar shows how busy each part of the episode is, so you can spot the hot scenes before you reach them. It counts only comments that pass your filters (in info danmaku mode, only the informative ones), follows in-place episode changes, hides during ads, and can be turned off in the popup.
- **Skip OP**: Guesses the opening song from the danmaku and marks its start and end with ◣ ◢ above the progress bar (also with the density curve off). While it plays, a Skip OP button at the lower right of the player jumps to its end. Viewers post "空降 1:30" when the OP starts (the time is where it ends; the skip lands 2 s before it), "空降成功" / "謝謝指揮官" just after it ends, a burst of "op君" when it starts, "開頭OP" in the first 30 s when it starts the episode, and "不跳OP" at one of its ends; without "空降 {time}" the OP is taken as 88 s (1:28) long. Failing those, the 88 s span with the most comments about the OP is taken. "op君陣亡" / "OP已死" / "OP君已離線" / "沒OP" mark an episode without an OP. The OP must start in the first 40% of the video; films (劇場版, or 45 min and longer) use only "空降 {time}". Works with few comments get their OP from the sound: each episode of a work plays the same OP, so the extension compares a few numbers per second of sound (loudness, brightness, band balance; no recording, nothing sent) between the episodes you play, and the repeated part early in the episode is the OP. Once an OP has been seen whole, later episodes match it a few seconds after it starts and know its end at once. A sound match wins over the comment guess; it can be turned off on the settings page. Episodes with no such comments get no marks and no button. Bahamut leaves out comments that match your official keyword filters; when those filters would hide OP clues (a filtered "空降", ":" or "op"), the OP guess uses the list fetched once more without cookies, and what you see does not change. Shares the density curve's setting. When reporting is set up, a "⚑ Wrong OP" button above it (or the popup) reports a wrong guess with one click. When the pointer rests on the left 40% of the progress bar or in the lower-left corner early in the episode (you are likely about to skip the OP by hand), a faint copy of that button shows next to the pointer. The first time, a dialog lists what is sent (the episode number, the current guess, the video time, your last 5 seeks in the episode and the extension version) and sends nothing until you agree; the settings page can take the agreement back. Reports go to the developer's Google Sheet through a Google Apps Script web app. See [PRIVACY.md](PRIVACY.md) for all data the extension keeps or sends.

### 2. Multi-Layer Hybrid Filtering System
To maintain perfect video performance while evaluating thousands of comments, the filtering engine works in two passes:

- **Pass 1: Instant Fast-Filter (Blocklists)**
  - Instantly blocks comments originating from blocked User IDs.
  - Instantly blocks comments containing blocked keywords.
  - **Webpage Integration**: Automatically reads your keyword filters from Bahamut's "進階設定" panel (server-rendered in the page) and follows them as you add or delete keywords.
  
- **Pass 2: AI Semantic Filtering (Gemini Nano)** — *not tested yet: in a store install it is off, whatever the stored setting, and its switch on the settings page is hidden (`AI_FILTER_READY` in `content.js`). Loaded unpacked, the switch shows (see Installation for Development).*
  - Checks comments ahead of the playhead (up to 5 minutes, soonest first, also while paused), so results are ready before comments are due. Each unique text is checked once and the result is kept for the page, so repeated texts ("www") cost nothing. Uses Chrome's built-in local Prompt API (`LanguageModel`).
  - A comment that is still unchecked 3 s after its time is dropped. If the AI is unavailable, comments show unfiltered.
  - The AI evaluates the semantics of the comment to catch *spoilers (劇透)*, *inappropriate sexual intent*, and *toxic behavior*, including comments that try to evade standard filters using similar phonetics or symbols.

### 3. Interactive Danmaku Context Modal
- **Click to Pause & Inspect**: Clicking on any moving danmaku instantly pauses the video and opens a beautifully styled modal.
- **Contextual Actions**: From the modal, you can see the comment's timestamp and author ID, and you have one-click buttons to:
  - **Copy** the text.
  - **Block User** (Instantly purges all their comments from the screen).
  - **Filter Text** (Instantly adds the phrase to your blocklist).
- **Adaptive Design**: The modal supports automatic Light/Dark mode themes based on your system preferences.

### 4. Popup and Settings Page
The toolbar popup (`popup/`) holds the switches used while watching (our layer, live updates, info mode, density curve, Skip OP), the one-click wrong-OP report, and buttons for the bookmark manager, the search page and the settings page.

The settings page (`options/`; "All settings" in the popup, or right-click the toolbar icon → Options) has every setting, each with its description shown in full:
- **While watching**: the same switches as the popup.
- **General**: interface language.
- **Player**: OP audio match, and clicking 同意 on the per-episode rating notice for you (`agegate.js`, on by default), so episodes start on their own. Bahamut shows a rating reminder before every episode (the rating is set per episode), and some 限制級 works also need age verification on your account (`animeAgeValidate.php`). This setting never touches that verification and never agrees for you the first time: only after you manually click 同意 on a rating yourself (`Event.isTrusted`) are that rating and all lower ones (for example, manually agreeing to 限制級 18+ also covers 輔15 and below) agreed for you from then on, per Bahamut account (kept as a short hash of the `BAHAID` account ID); any higher rating still waits for your own click. The page shows the remembered rating and can clear it.
- **Blocking**: your keyword and user ID blocklists (press Enter to add).
- **OP reports**: whether you agreed to send reports, and a link to take it back.
- **Debugging**: export or clear the debug log (errors only). Debug mode is a development setting, hidden in a store install.

Both pages read the stored settings again before every change (`options/settings-ui.js`), so a change made in one place (the popup, the page in another tab, the player's own button) is never undone by another.

### 5. Danmaku Search Across Works
- **Find the scenes viewers reacted to**: search the comments of your subscribed works (or works you add by URL) for keywords such as 高能, and get a list of moments with the number of matching comments.
- **Jump straight there**: each result opens the episode at that time (`animeVideo.php?sn=…&t=…`).
- Opened from the popup; when the current tab is an episode, its work is already selected. Requests run 2 at a time, at most one start every 0.5 s, with a pause when Bahamut refuses them, and fetched lists are reused for further searches on the same page.

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
- **`i18n.js`**: Interface text in Traditional Chinese (Taiwan, the default) and English, switched on the settings page. `_locales/` holds only the extension name and description, which Chrome shows in the browser's own language.
- **`density.js`**: Draws the density curve as an SVG inside the player's `.vjs-progress-holder`.
- **`opskip.js`**: Finds the OP from the danmaku, for the ◣ ◢ marks above the progress bar and the Skip OP button.
- **`infomode.js`**: Finds the informative comments for info danmaku mode; `content.js` sets their opacity.
- **`audioprobe.js`**: Records per-second audio numbers through `video.captureStream()` for the OP audio match (`opaudio.js`). Keeping every second for export with the debug log is a development tool: hidden and off in a store install (`AUDIO_PROBE_READY` in `content.js`). The debug log keeps only errors unless "Debug mode" (a development setting, hidden and off in a store install) is on.
- **`content.css`**: Hides the native comments, styles our comments like the official ones, and provides the light/dark mode UI for the contextual modal.
- **`search/`**: The danmaku search page (`search.html`/`.js`/`.css`), an extension page that reads the subscription list, episode lists and comment lists with the Bahamut login cookie.
- **`bookmarks/`**: Scene bookmarks. `common.js` holds helpers shared by every context; `store.js` (imported by `background.js`) is the single writer to `chrome.storage.local`, which serializes updates from the page and the manager; `content-bookmarks.js`/`.css` is the in-player toolbar, panel and quick editor; `manager.html`/`.js`/`.css` is the full-page manager.

## Installation for Development

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked** and select the directory containing this repository.
4. Navigate to any Bahamut Anime Crazy video (e.g., `https://ani.gamer.com.tw/animeVideo.php?sn=19849`) to see it in action.

An unpacked copy is a development build: its manifest has no `update_url`, which the Chrome Web Store adds to every store install (`DEV_BUILD` in `content.js`). It shows a DEV badge on the toolbar icon, and the settings page shows the development switches: debug mode, the audio probe and the AI filter. If the store version is also installed, turn one of them off in `chrome://extensions`; otherwise both draw their layer on the player.
