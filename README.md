# 日文練習 PWA V1.6.0

完整程式，以 GitHub main 的 V1.5.4 為基礎。本次只提供完整 ZIP，未部署 GitHub 或 Cloudflare。所有檔案在同一層，不含 node_modules、私人金鑰或舊版副本。

## 更新內容

- 開啟直接進入首頁，使用 Cloudflare 後端在背景恢復 Google 雲端連線；啟動不載入 GIS、不開登入視窗。
- 第一次連結仍需點擊並同意 Google 授權；權限撤銷或工作階段過期時在設定頁提示，練習仍可使用。
- 手寫設定與書寫頁新增可保存的自動發音開關。開始／下一題同步播放、失敗提示與手動重播。
- IndexedDB 載入完成後還原音效與排序。最新詞排序支援數字 ID、daily ID 與匯入日期；同詞保留原加入時間。
- 備份整理、雜湊、驗證、解析和比對交由背景 Worker。每日例句逐筆寫入，保留同日全部生成記錄。
- 保留貼底導覽、原頁筆跡下方分數、手寫完成總結、讀音鍵盤和答題音效、例句反藍、完整行過濾、例句詞自動收錄、通知與 schema 1–3 備份相容。

## 先更新前端

1. 設定頁先匯出完整備份或救援 JSON。
2. 解壓 `PWA-Japanese-GD-V1_6_0-FLAT.zip`，外層資料夾與 ZIP 檔名相同。
3. 將裡面的檔案更新至原 GitHub repository 根目錄，保留 GitHub Pages 設定，不再包一層版本子資料夾。
4. 發布後開啟 PWA，等待閒置時自動更新；或在設定頁按「檢查更新」，確認目前／最新版本為 V1.6.0。
5. 不刪除 PWA、不清除網站儲存，不改 IndexedDB 名稱。未完成後端設定前本機練習和原通知照常使用；舊 Google access token 在有效期內可暫時使用。

## 一次設定 Cloudflare 自動登入後端

本版沿用 `japanese-daily-reminder` Worker 和 `vocabulary-reminders` D1，新增四個授權表，不刪除通知或學習資料。Cloudflare 的 Wrangler 登入與使用者的 Google 登入是兩件事。

### 1. Google OAuth 設定

在 Google Cloud Console 選擇目前專案：

1. 啟用 Google Drive API。
2. 編輯「網頁應用程式」OAuth 用戶端，在「已授權重新導向 URI」加入：

   `https://japanese-daily-reminder.rexchre.workers.dev/api/auth/callback`

3. 使用其他 Worker 網域時替換前半段，結尾仍為 `/api/auth/callback`，必須精確相同。
4. 保留前端來源 `https://lihe-source.github.io`，並確認允許登入的帳號符合測試使用者／目標對象設定。
5. 取得同一用戶端的 Client ID 與 Client Secret。`wrangler.toml` 的 `GOOGLE_CLIENT_ID` 預設沿用既有 ID；建立新用戶端時改成新 ID。
6. 本版請求 `openid`、`email`、`drive.file`。外部應用若仍為 Testing，含 Drive 權限的 refresh token 可能在 7 天後失效；長期使用請依 Google 規則完成正式發布。第一次或撤銷授權後的同意程序不能跳過。

### 2. 確認 Cloudflare 帳號

在本版 package.json 所在資料夾：

```bash
npm ci
npx wrangler whoami
```

尚未登入時，Codespaces 可透過 secret 設定 `CLOUDFLARE_API_TOKEN`，權限包含該帳號的 Workers Scripts Edit 與 D1 Edit，再重新開啟終端機。也可用 `npx wrangler login`，但 localhost 回呼必須能送回執行 Wrangler 的環境。

### 3. 加入兩個新的 Worker secrets

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run auth:key
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
```

- 第一個提示貼上同一 OAuth 用戶端的 Client Secret。
- auth:key 產生 32 bytes 的 base64url 加密金鑰，將輸出貼至最後一個指令的 secret 提示，不要貼到公開對話或存進原始碼。
- 安全備份加密金鑰，日後更新沿用原值，不要每次重新產生。更換金鑰會使舊密文無法解密，需要重新連結 Google。
- 原有 `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT` 沿用，無須重新生成。

### 4. 初始化新增資料表並發布 Worker

先確認 wrangler.toml：

| 設定 | 本專案值 |
|---|---|
| APP_URL | `https://lihe-source.github.io/PWA-JP-GD/` |
| ALLOWED_ORIGINS | `https://lihe-source.github.io` |
| DB | 保留既有 vocabulary-reminders 和 database_id |
| GOOGLE_CLIENT_ID | 與新 secret 配對的用戶端 ID |

```bash
npm run db:init
npm run worker:deploy
npx wrangler secret list
```

db:init 僅使用 CREATE TABLE IF NOT EXISTS 與索引，無 DROP 或清除資料。接受 Wrangler 的 D1 提示後部署；secret 清單應包含新增兩個名稱和原三個 VAPID 名稱，不會顯示內容。

Worker 網址不同時，也要更新 push-config.js 的公開 apiBaseUrl，並在 PWA 設定頁保存「Cloudflare 自動登入服務網址」。預設支援 workers.dev 網域；自訂網域也須加入 index.html 的 CSP connect-src。Google Secret、refresh token 與加密金鑰只放 Worker，不放 GitHub 或前端。

### 5. PWA 首次連結一次

1. 設定 → Google Drive 設定 →「檢查自動登入服務設定」，應顯示設定完成。
2. 按「首次連結 Google 帳號」；原帳號者按「重新連結 Google（啟用自動登入）」。
3. 選帳號並同意備份權限，授權成功後回到 PWA。
4. 確認已連結，測試上傳／還原清單，再完全關閉並重開 PWA。首頁直接出現，雲端連線背景恢復。
5. 手寫開始／下一題應發音；關閉開關後停止自動播放，仍可手動重播，重開保留選擇。

指定資料夾發生 403／404 時，確認資料夾已授權給同一 Google 應用；drive.file 不代表可存取整個 Drive。可清空資料夾 ID 改在根目錄測試，舊檔案不會自動刪除。

## 連線與離線行為

Google access／refresh token 經 AES-GCM 加密留在 D1。裝置僅保存可撤銷的隨機工作階段憑證，不依賴第三方 Cookie。Google Secret、裝置登入憑證和通知訂閱都不放備份。

裝置工作階段閒置 30 天失效，有效連線可延長至初次授權起最多 180 天。新裝置、過期或撤銷權限需要重新連結。離線不自動登出、不跳視窗，本機練習不受影響。

「登出這台裝置」只撤銷本裝置，離線登出在恢復連線後補送。「解除 Google 連結（所有裝置）」撤銷 Google 授權，其他裝置須重新連結。

## 驗證與操作

建議 Node.js 22.13+，本版驗證使用 Node.js 24：

```bash
npm run check
npm test
npx wrangler deploy --dry-run
```

157 項測試包含 OAuth 模擬／真 SQLite D1 介面、並行續期、登出競態、歷史資料遷移與失敗保留、背景備份、相容、原頁評分和連續 50 題 canvas 復用。Node 20 會略過 SQLite 後端測試。

本機畫面可用 `python3 -m http.server 8000`。Google 正式授權與 Web Push 須使用正確 HTTPS 前端和已設定的 Worker。測試環境未登入您的 Google／Cloudflare，且未能啟用瀏覽器；iPhone／iPad 版面、iOS 播放與 Apple Pencil 須發布後實機確認。

剩餘效能改善範圍和程式規範見 ARCHITECTURE.md，更新記錄見 CHANGELOG.md。
