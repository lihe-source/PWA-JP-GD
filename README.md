# PWA Japanese GD V1.2.5

以繁體中文操作的日文學習 PWA，可直接部署到 GitHub Pages。保留原英文版的語彙、測驗、閱讀、寫作、Gemini AI、統計、Google Drive 備份、連續練習天數與每日 Web Push 提醒，並新增適合 iPad Air 11 吋與 Apple Pencil 的五十音手寫練習。

本交付包採完全扁平結構：所有檔案都在 ZIP 根目錄，不需在手機上逐層建立資料夾。

## 主要功能

- 日文語彙庫：日文、假名讀音、羅馬拼音、詞性、繁體中文與 JLPT 等級。
- 每日推薦學習：可在設定選擇「單字庫」或「依等級學習」；後者依 JLPT N5～N1 與複選五十音行，每日推薦 5 個單字。
- 推薦內容完整顯示日文表記、假名、羅馬拼音、詞性與繁體中文，並提供單字發音。
- 語彙練習：依日文表記、假名與中文進行測驗與複習。
- 五十音手寫：平假名 46 字、片假名 46 字，共 92 字。
- 選項記憶：保留上次練習模式、題數、出題順序、假名類型、五十音行、重複次數、書寫模式與版面選擇。
- 五十音行複選：可依進度同時選取多個行別；「全部行」可一鍵重設。
- 重複加深印象：每個已選假名可重複 1、2、3、5 或 10 次，再以平衡隨機方式排題；例如あ行 5 字 × 5 次＝25 題，而且相同假名不會連續出現。
- 精簡單頁設定：手機上將常用設定集中在一個畫面內，版面與弱項優先等進階選項預設收合，減少開始前的捲動距離。
- 手寫模式：描寫、臨摹、默寫；提供筆順動畫、格線、復原、清除與提示。
- 手寫自動發音：第一題及每次切換「下一個假名」時，立即以裝置內建日文語音播放該假名；可在更多設定關閉，並保留手動重聽按鈕。
- 裝置版面：自動辨識 iPhone／iPad，也可手動切換；iPhone 書寫時將「評分」停在導覽列上方，評分後則依序顯示完整評分卡與下一步按鈕。
- 本機輔助評分：比較筆畫數、形狀、方向、端點與版面位置；不需上傳筆跡。
- 閱讀測驗、文章寫作與 AI 問答：依 JLPT N5～N1 調整內容。
- 首頁學習天數：目前連續、歷史最久與累積練習天數。
- 同一 Google 帳號跨裝置同步練習日與五十音手寫紀錄。
- 完整 JSON、各項 CSV 與一鍵 ZIP 備份／還原。
- iPhone、iPad 與桌面 PWA 每日定時推播提醒。
- iPhone 推播訂閱自動修復：Apple 回傳失效狀態時會重新訂閱並重送一次。
- 快速雲端操作：首頁先顯示、Google 元件預載、登入後背景同步，備份與還原提供階段進度及逾時保護。
- 帳號自動恢復：首次授權後記住帳號，日後開啟直接進入主畫面；背景續權使用無提示模式，不再主動開啟帳號選擇或確認畫面。

## 已預設的 Google 設定

| 項目 | 預設值 |
|---|---|
| OAuth Client ID | `171837667604-mtcf91qudt6ff79u382v37rjqpp7l51q.apps.googleusercontent.com` |
| 日文版 Drive 資料夾 ID | `1kAtVOK2qqhK0BY9vmp8Sm4NhQaWMJYeb` |
| 初始程度 | JLPT N5 |

OAuth Client ID 可以與英文版共用，因兩個 GitHub Pages 專案位於相同來源 `https://lihe-source.github.io`。Gemini API Key 也可使用同一把，但基於安全考量不會寫入 ZIP；請在設定頁貼上。若同一瀏覽器可讀取既有英文版儲存空間，程式會在首次啟動嘗試帶入相容的 Gemini Key、模型與 OAuth Client ID。

英文與日文學習資料不會混用：日文版使用獨立 IndexedDB、獨立本機鍵名前綴、獨立 Drive 資料夾及獨立備份檔名。

## 快速部署

1. 解壓 ZIP，將所有檔案直接上傳至 `lihe-source/PWA-JP-GD` 的 `main` 分支根目錄。
2. GitHub Repository 開啟 **Settings → Pages**。
3. Source 選 **Deploy from a branch**，Branch 選 `main`，Folder 選 `/(root)`。
4. 部署完成後開啟：`https://lihe-source.github.io/PWA-JP-GD/`。
5. Google Cloud OAuth 的「已授權的 JavaScript 來源」確認已有 `https://lihe-source.github.io`；來源不可加 Repository 路徑。
6. 依 `SETUP_PUSH_NOTIFICATIONS.md` 部署 Cloudflare Worker，才能在 PWA 關閉後於指定時間通知。
7. iPhone／iPad 以 Safari 開啟網站，加入主畫面後再從圖示啟動。

手機上傳的逐步畫面路徑請見 `MOBILE_UPLOAD_GUIDE.md`；系統架構與資料隔離請見 `ARCHITECTURE_V1_2_5.md`；本版變更請見 `CHANGELOG_V1_2_5.md`。

## 重要檔案

| 檔案 | 用途 |
|---|---|
| `index.html`、`app.js`、`style.css` | PWA 介面與學習功能 |
| `kana-data.js`、`kana-strokes.js` | 五十音資料與標準筆畫 |
| `handwriting-engine.js` | iPad／Apple Pencil 手寫畫布及本機評分 |
| `japanese-learning.js` | 日文正規化、預設設定與手寫進度 |
| `daily-learning.js` | JLPT／五十音行設定、AI 結果驗證、假名轉羅馬拼音與每日快取簽章 |
| `storage.js`、`backup-schema.js` | 隔離儲存與完整備份 Schema |
| `sw.js`、`manifest.json`、Icon | 安裝、離線快取與系統通知 |
| `worker.js`、`schema.sql`、`wrangler.toml` | Cloudflare 定時推播後端 |

## 本機驗證

需要 Node.js 20 或更新版本：

```bash
npm install
npm run check
npm test
```

請勿將 Gemini Key、VAPID Private Key 或 Cloudflare API Token 放入 GitHub Repository。
