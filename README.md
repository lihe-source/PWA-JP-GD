# 日文練習 · 藍墨 V1.3.5

GitHub Pages： https://lihe-source.github.io/PWA-JP-GD/

本版以使用者已確認的 V1.3.4 為基底：若使用者在設定的提醒時間前已完成任一正式練習，Cloudflare 當天就不發送每日練習通知，隔天恢復判斷。保留貼底排版、讀音隱藏提示、資料、帳戶與原通知訂閱。

## 這次更新

- 單字拼寫、五十音手寫、五十音讀音、閱讀、文章撰寫或 AI 詢問完成時，都會寫入正式練習日並同步完成時間。
- Worker 排程在發送前依該訂閱的時區核對：同一天、且完成時間早於或等於原定提醒時間，就略過當天通知。
- 完成判斷和通知訂閱一樣以裝置為單位；每台裝置只傳送隨機識別的匿名雜湊，不傳 Email 或 Google Token。
- 測試通知仍會立即發送，不受「今日已完成」影響，方便測試通知本身。
- 離線完成先留在本機，恢復網路後自動重試；若直到提醒時間後仍無法連上 Worker，雲端排程無法預先知道該次完成。
- 上傳本包 46 個同層檔案後，確認版本為 V1.3.5。此版須建立兩個 D1 輔助表並重新部署 Worker，但不必更換 VAPID Keys 或重新建立 D1。

### 保留已確認的貼底排版

- 與英文版相同，viewport 由瀏覽器管理安全邊界，移除 viewport-fit=cover；頁面仍允許正常縮放。
- 導覽列固定於 bottom: 0，基準高度 64px；保留環境提供的安全區 fallback，移除日文版額外的底部內距與獨立滿版高度。
- App 內容區預留與導覽列相同的高度。手寫評分／下一題仍有獨立操作列，內容能完整捲動至最下方。
- 藍色選取狀態、至少 48px 導覽觸控目標與 iPad／桌面側邊導覽保留；寬版移除底部預留，避免側邊導覽時仍出現底部空白。
- 這次以程式語法及自動化回歸檢查驗證；未在 iPhone／iPad 實機驗證顯示。更新後請確認首頁底部與手寫操作列，並試一次直橫向切換及讀音鍵盤。

### 保留 V1.3.0 設計

- 首頁：品牌列、連續／歷史最長天數、真實本週紀錄、每日推薦與例句，以及手寫／讀音捷徑。
- 例句與天數使用實際資料，不含提案圖的範例數字。未設定 Gemini 或沒有紀錄時會顯示說明。
- 所有練習模式共用緊湊選單、霧藍選取狀態與統一按鈕。
- iPhone 手寫：上方題目、可捲動內容、獨立的評分／下一題操作列；操作列不蓋住畫布或成績。
- iPad 寬版：左側範例與評分，右側正方形畫布與操作列。以視窗寬度適應橫豎向及分割畫面；更多設定仍可手動指定版面。
- 預設保留正常縮放、16px 輸入文字與至少 44px 主要觸控目標。畫布區維持手寫手勢，其他區域可捲動。
- 「資料保存」仍位於設定頁最下方。
- 46 個同層檔案；說明固定為 README.md、ARCHITECTURE.md、CHANGELOG.md。

## 從 V1.3.2 或舊版更新：手機操作

1. 在舊程式「設定」先完成上傳備份；也建議匯出救援備份，保存在裝置。
2. 下載並解壓本 ZIP。開啟與 ZIP 同名的外層資料夾，裡面是 46 個檔案。
3. 到 https://github.com/lihe-source/PWA-JP-GD ，使用 **Add file → Upload files** 上傳這 46 個檔案，覆寫同名檔案。不要把外層資料夾整個上傳，index.html 必須仍在 Repository 根目錄。
4. Commit 到原本的 main。維持 **Settings → Pages → Deploy from a branch → main → /(root)**。
5. GitHub Pages 部署完成後開啟 PWA。設定頁會顯示目前版本、最新版本和檢查更新按鈕；開啟程式也會檢查更新。
6. 練習中、備份中或本機寫入未完成時，新版不會強制重載；作業結束且資料保存成功後才套用。
7. 確認首頁右上角與設定頁目前版本均為 V1.3.5。若仍顯示舊版，回到首頁結束練習／備份後，在設定頁按「檢查更新」及「立即更新」。請勿清除網站資料或移除 PWA，以免影響尚未備份的本機紀錄。
8. 在 Codespaces 專案根目錄依下方 Cloudflare 步驟執行 `npm run db:init` 及 `npm run worker:deploy`。原 VAPID Secrets 保留，不要重新產生。

上傳新版不會自動刪除 GitHub 已有的舊檔。下方列出的舊文件及原始圖可在確認更新正常後做一次性清理。不要刪除不在清單中的程式、設定或授權檔。

### 一次性清理舊檔

可刪除 `ARCHITECTURE_V*.md`、`CHANGELOG_V*.md`、`QA_V*.md`、`UPDATE_V*.md`，以及 `CURRENT_SETTINGS_INCLUDED.md`、`MOBILE_UPLOAD_GUIDE.md`、`SETUP_PUSH_NOTIFICATIONS.md`、`icon-source-1024.png`、誤植的 `indexl.html`。

新版的三個固定文件已承接現行架構、部署與更新說明。旧版本仍可從 Git commit 紀錄查閱。若在 Codespaces 操作，先執行 `git status` 確認沒有尚未保存的工作，再依上述明確檔名刪除，檢查 diff 後提交。不要刪除整個 Repository 或先清空再上傳。

系統可能沿用已安裝 PWA 的舊圖示；即使圖示尚未刷新，只要設定顯示 V1.3.5 就是新版。不要為更新圖示直接刪除 PWA 或網站資料。必要重裝前先備份並確認可以還原；重装後每台裝置須重新檢查通知訂閱。

## 已保留設定

| 項目 | 內容 |
|---|---|
| OAuth Client ID | `171837667604-mtcf91qudt6ff79u382v37rjqpp7l51q.apps.googleusercontent.com` |
| Drive 資料夾 ID | `1kAtVOK2qqhK0BY9vmp8Sm4NhQaWMJYeb` |
| OAuth JavaScript 來源 | `https://lihe-source.github.io`，不加路徑 |
| Worker | `japanese-daily-reminder` |
| Worker URL | `https://japanese-daily-reminder.rexchre.workers.dev` |
| D1 | 沿用 wrangler.toml 的 vocabulary-reminders Binding；日文表 japanese_reminders |
| Cron | `* * * * *` |
| 學習偏好 | 原使用者的等級、來源、行別、次數、模式均不重設 |

API Key、VAPID 私密金鑰、Cloudflare Token 及 Google access token 不包含在 ZIP。不要把這些內容 commit 到 GitHub。Google 首次授權、工作階段失效或撤銷授權時仍可能要求操作；自動登入不是繞過 Google 的授權機制。

## Cloudflare（V1.3.5 必須執行一次）

V1.3.5 新增完成回報 API 與兩個 D1 輔助表。在專案根目錄依序執行：

```bash
npm ci
npm run db:init
npm run worker:deploy
```

`db:init` 使用 `CREATE TABLE IF NOT EXISTS`，不會清除既有 `japanese_reminders`、訂閱或提醒時間。出現確認時輸入 `Y`。部署後開啟 Worker 根網址，應顯示 `version: V1.3.5`、`configured: true`。

首次建立此服務才執行以下流程：

```bash
npm ci
npx wrangler login
npm run db:init
npm run worker:deploy
```

確認登入的 Cloudflare 帳號具有 wrangler.toml 所列 D1 的權限，才執行遠端資料庫命令。schema.sql 只建立日文資料表與索引，不删除資料。如果既有 D1 不屬於該帳號，先確認正確帳號或自行建立新的 D1，再修改綁定；不要覆蓋仍在使用的資料庫設定。

### 三個 Secrets

保留原來成對的 VAPID Keys；不要因 UI 升級而重新產生。首次設定才執行：

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
npm run worker:deploy
```

SUBJECT 使用 `mailto:你的Email`。找不到原始 private key 才使用 `npm run vapid:generate` 產生新的一對；換 Keys 後每台裝置都需要重新啟用訂閱。

若 `wrangler login` 顯示 localhost:8976 被占用，在原先的登入終端機按 Ctrl+C 結束舊登入再重試；Codespaces 是遠端環境，回呼位置需正確轉送。不要把舊 OAuth 連結反覆重開，也不要公開 Token。

### 通知排除順序

1. Worker 根網址的 `configured` 和 `checks`。若資料庫項目 false，檢查 D1 綁定與資料表；若 VAPID 項目 false，檢查对应 Secrets，公開和私密 Key 必須成對。
2. `APP_URL` 應為完整日文 Pages 網址；`ALLOWED_ORIGINS` 為 `https://lihe-source.github.io`。
3. iPhone／iPad 從 Safari 加入主畫面，再從 PWA 設定啟用通知；各裝置各自授權與訂閱。
4. Apple 測試失敗時，先檢查 Worker 紀錄的 HTTP 狀態與 `providerReason`，不要把所有錯誤當成網路問題。既有失效訂閱重建及一次重試機制保留。
5. 測試成功但排程未顯示時，再檢查 Cron、裝置時區、下次提醒、通知權限和專注模式。

```bash
npx wrangler secret list
npx wrangler tail japanese-daily-reminder --format pretty
```

請不要公開完整推播 endpoint、Keys 或包含私人資料的紀錄。每日排程會在發送前檢查 `japanese_practice_days`；測試通知則刻意略過此檢查。Web Push 仍須系統／網路傳遞，無法保證精準秒級到達。

## 資料、備份與更新保護

- 日文仍使用獨立的 `pwa_japanese_v1` IndexedDB 與 `pwa_japanese:` 前綴。
- 不刪除使用者資料，不改 Schema 1；可讀取相容的舊日文備份。
- 手寫筆跡取樣、繪圖批次、讀音鍵盤與音效維持原來流程。
- 六種練習模式、每日一詞及例句紀錄、統計與跨裝置練習天數均保留。
- 完整備份涵蓋學習偏好與紀錄；通知授權、訂閱及「今天已完成」的通知判斷均是每台裝置獨立。
- 自動更新保留等待儲存和練習結束的保護。

## 開發檢查

需要 Node.js 20 或更新版本；前端不用編譯，直接上傳即可。Cloudflare 部署才需要安裝套件。

```bash
npm ci
npm run check
npm test
```

本次交付執行本機語法與回歸檢查；不等同於 iPhone／iPad 真機、Google 授權、實際 Drive 寫入或 Apple Push 端到端測試。圖像提案中的評分展示以現有實際欄位「筆形／畫數／方向／起收筆／配置」落實；評分只是本機輔助，不宣稱能辨識筆順。

部署後驗收：首頁資料正確、六種模式可切換、手寫可連續畫筆／評分／下一題、讀音 Enter 可送出與換題、設定資料保存仍在最下方、備份還原正常、各裝置測試通知成功、版本顯示 V1.3.5。另把提醒暫設為數分鐘後，完成一個練習並確認首頁顯示「今天已完成練習」；時間到後不應收到每日提醒。測試通知仍應立即收到。

技術架構見 ARCHITECTURE.md，變更歷程見 CHANGELOG.md。JSZip、KanjiVG 與 icon 授權見三份授權文件。
