# Privacy Policy

Effective date: 2026-10-29

This policy covers the Chrome extension "Bahamut Danmaku Enhancer" (巴哈彈幕增強, the extension). It works only on ani.gamer.com.tw (巴哈姆特動畫瘋).

## Summary

- Almost all data stays in your browser, in the extension's own storage (`chrome.storage.local`).
- The extension sends data to the developer only when you report a wrong OP position. You must agree once before the first report.
- The extension does not sell data, does not show ads, and does not use data for ads.
- The extension does not send your account, nickname, password, cookies or comments to the developer.

## Data that leaves your browser

### 1. Requests to ani.gamer.com.tw and api.gamer.com.tw

The extension loads danmaku (comments), episode lists and work information from Bahamut, the same way the official player does. These requests go only to Bahamut and carry your normal Bahamut login cookies. The danmaku search page can also read your subscribed works and your watch history from Bahamut, to let you pick works to search. The extension shows this data on your screen and does not send it anywhere else.

### 2. OP reports (only when you click "OP 不對")

When the OP guess is wrong, you can report it with one click. The first time, the extension shows what it sends and asks you to agree. Without your agreement, nothing is sent. You can take back your agreement in the extension popup at any time.

A report contains only:

- the episode number (`sn`) of the video you are watching
- the extension's OP guess for that episode (start, end, and how it was found)
- the video time when you clicked, and the video length
- your last few seeks in that episode (from which video time to which video time), so the developer can see where you jumped
- the extension version

A report does not contain your account, nickname, cookies, comments, IP address, browser history or any other URL.

The extension sends the report over HTTPS to a Google Apps Script web app, which adds one row to the developer's Google Sheet. Google receives the connection (for example your IP address) as the host of that service, under the [Google Privacy Policy](https://policies.google.com/privacy). The script does not get your IP address and does not store it.

Only the developer reads the reports. The developer uses them only to find and fix wrong OP guesses. The developer does not share them, except as the law requires. Reports are kept as long as they help to improve OP detection, and are deleted when they are no longer useful. Because a report holds no account or contact data, the developer cannot find which report is yours.

## Data kept only in your browser

The extension keeps this data in `chrome.storage.local`. It does not send it anywhere. Removing the extension deletes all of it.

- **Settings**: your choices in the popup, your keyword and user filters, and the interface language.
- **Scene bookmarks**: the episode, time, title, note and tags that you enter, and a small thumbnail image of that moment.
- **Age-rating memory**: the highest rating level you agreed to on Bahamut's rating notice. It is kept per Bahamut account, under a short one-way hash of the account cookie, not the account name. The popup can clear it.
- **OP report agreement**: whether you agreed to send OP reports.
- **Debug log** (newest 5000 entries): technical events, for example page and episode loads, comment counts, ad start and end, seeks, playback stalls, setting changes, OP guesses and errors. It can hold episode numbers and page addresses on ani.gamer.com.tw, and the text of comments that the AI filter hid. It does not hold your account or cookies.
- **OP review list** (`opSkipReview`, newest 300 episodes): episodes where no OP could be guessed, with the episode number, title, length, and up to 30 public comments about the OP from that episode.
- **Audio features** (`audioProbe`, a test setting, off by default): per-second numbers about the sound of an episode, such as loudness and pitch balance. It records no audio and no speech.

The debug log, the OP review list and the audio features leave your browser only if you click "Export" in the popup. Then they are saved as a file on your computer, and you decide what to do with it. "Clear" in the popup deletes them.

## AI filter

The AI filter uses the language model built into Chrome (Gemini Nano), which runs on your device. Comment text is checked on your device and is not sent to the developer or to any other server by the extension.

## Children

The extension is not made for children under 13 and does not knowingly collect data from them.

## Changes

If this policy changes, the new version is published with the extension, with a new effective date. If the extension starts to send new kinds of data, it will ask for your agreement first.

## Contact

<!-- TODO: add a contact address or the project's issue page before publishing. -->
Questions about this policy: contact the developer through the extension's Chrome Web Store page.

---

## 中文摘要

本摘要僅供參考，內容以上方英文版為準。

- 幾乎所有資料都只存在你的瀏覽器（`chrome.storage.local`），移除擴充功能即全部刪除。
- 只有在你按下「OP 不對」回報時，才會把資料送給開發者；第一次回報前會先列出送出的內容並請你同意，可隨時在彈出視窗撤回同意。
- 回報只包含：本集編號（sn）、擴充功能的 OP 推測、你按下時的播放時間與影片長度、你在這一集最近幾次跳轉的時間點、擴充功能版本。不含帳號、暱稱、Cookie、彈幕、IP 位址或其他網址。
- 回報以 HTTPS 送到 Google Apps Script，寫入開發者的 Google 試算表；只由開發者閱讀，只用來改進 OP 偵測，不出售、不用於廣告。
- 除錯紀錄、OP 待檢查清單與音訊特徵只存在本機，只有你按「匯出」時才會存成檔案。
- AI 過濾使用 Chrome 內建、在你裝置上執行的模型，彈幕不會因此被送出。
