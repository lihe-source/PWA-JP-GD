# GitHub Pages＋每日推播提醒設定指南（V7.4.2）

本版本使用兩個部署位置：

- **GitHub Pages**：放置 PWA 前端。
- **Cloudflare Worker＋D1**：保存每台裝置選擇的每日時間，並於時間到達時傳送 Web Push。

GitHub Pages 是靜態網站，無法在 PWA 關閉後執行計時器，因此不能省略 Worker。一般個人使用量通常可在 Cloudflare Workers 與 D1 免費方案額度內運作；實際額度仍以 Cloudflare 當下方案為準。

## 一、準備資料

需要：

1. GitHub 帳號。
2. Cloudflare 帳號。
3. Windows 11 電腦。
4. Node.js 20 或更新版本。

請勿把下列資料寫入 GitHub 檔案：

- `VAPID_PRIVATE_KEY`
- `CLOUDFLARE_API_TOKEN`
- Cloudflare 登入憑證

## 二、部署 PWA 到 GitHub Pages

1. 在 GitHub 建立或開啟原本的 PWA Repository。
2. 本交付 ZIP 採扁平結構；解壓後將全部檔案直接上傳到 Repository 根目錄。
3. 到 Repository 的 **Settings → Pages**。
4. 在 **Build and deployment** 選擇：
   - Source：`Deploy from a branch`
   - Branch：`main`
   - Folder：`/(root)`
5. 按 **Save**，等候 GitHub Pages 完成部署。
6. 記下 PWA 網址，例如：

   ```text
   https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY/
   ```

如果 Repository 名稱是 `YOUR_GITHUB_USERNAME.github.io`，網址通常沒有 Repository 路徑：

```text
https://YOUR_GITHUB_USERNAME.github.io/
```

## 三、修改 Worker 的公開設定

編輯 `wrangler.toml`：

```toml
[vars]
ALLOWED_ORIGINS = "https://YOUR_GITHUB_USERNAME.github.io"
APP_URL = "https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY/"
```

注意：

- `ALLOWED_ORIGINS` 只能填網域來源，不可加 Repository 路徑，也不要加結尾 `/`。
- `APP_URL` 要填完整 PWA 網址，並保留結尾 `/`。
- 若有多個允許來源，以逗號隔開，例如：`https://a.example,https://b.example`。

## 四、第一次部署 Cloudflare Worker

在 Windows 檔案總管開啟專案資料夾，在網址列輸入 `powershell` 並按 Enter，依序執行：

```powershell
npm install
npx wrangler login
npx wrangler d1 create vocabulary-reminders
```

Cloudflare 會回傳 D1 Database ID。將它填入 `wrangler.toml`：

```toml
database_id = "剛才取得的-D1-Database-ID"
```

建立資料表：

```powershell
npx wrangler d1 execute vocabulary-reminders --remote --file=schema.sql
```

首次部署 Worker：

```powershell
npm run worker:deploy
```

成功後會顯示類似網址：

```text
https://vocabulary-daily-reminder.YOUR-SUBDOMAIN.workers.dev
```

請保存這個網址。

## 五、產生並保存 VAPID 金鑰

執行：

```powershell
npm run vapid:generate
```

畫面會顯示 `publicKey` 與 `privateKey`。不要把輸出貼到 GitHub。

依序執行以下三個指令。每次出現輸入提示時，貼上對應內容並按 Enter：

```powershell
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

填入規則：

- `VAPID_PUBLIC_KEY`：貼上 `publicKey`。
- `VAPID_PRIVATE_KEY`：貼上 `privateKey`。
- `VAPID_SUBJECT`：填入可聯絡的 Email，例如 `mailto:your-email@example.com`。

Secrets 儲存在 Cloudflare，不會出現在 GitHub Repository。

## 六、將 Worker 網址填回 PWA

編輯 `push-config.js`：

```javascript
export const PUSH_CONFIG = Object.freeze({
  apiBaseUrl: 'https://vocabulary-daily-reminder.YOUR-SUBDOMAIN.workers.dev',
  defaultTime: '20:00',
  defaultTitle: '英文單字複習時間到了',
  defaultBody: '每天複習一點點，保持英文學習節奏！',
  requestTimeoutMs: 15000
});
```

只替換 `apiBaseUrl`，不要把 VAPID 私鑰放進此檔案。將修改後的 `push-config.js` 與 `wrangler.toml` 提交到 GitHub，等候 GitHub Pages 更新。

開啟 Worker 網址，應看到：

```json
{"ok":true,"service":"Vocabulary Daily Reminder","version":"V7.4.2","configured":true}
```

若 `configured` 是 `false`，代表 D1、VAPID Secrets 或 `APP_URL` 尚未完成。

## 七、iPhone 啟用每日提醒

1. iPhone 必須使用 iOS 16.4 以上。
2. 從瀏覽器的分享選單選擇 **加入主畫面**。
3. 從主畫面圖示開啟「英文複習」。
4. 進入 **設定 → 每日學習提醒**。
5. 選擇每日提醒時間。
6. 按 **儲存並啟用**。
7. iOS 詢問通知權限時按 **允許**。
8. 按 **傳送測試通知**；正常情況下數秒內會收到系統通知。

提醒時間、時區與裝置訂閱會綁定目前這台裝置。不同 iPhone／iPad 必須各自啟用一次。

## 八、後續更新 Worker

為了讓手機可一次上傳全部檔案，本包刻意不建立 `.github/workflows/` 子資料夾。現有 Repository 若已有 Worker Workflow，普通檔案上傳不會刪除它，仍可沿用。若沒有 Workflow，可在原本設定 Worker 的終端機執行：

```powershell
npm install
npx wrangler login
npm run worker:deploy
```

只要 Worker 名稱與 `wrangler.toml` 的 D1 Database ID 不變，重新部署不會清除提醒資料；VAPID Secrets 仍保存在 Cloudflare，不需要重新輸入。

## 九、驗收檢查

依序確認：

- GitHub Pages 能正常開啟 PWA。
- Worker 根網址回傳 `configured: true`。
- PWA 是從 iPhone 主畫面開啟，不是一般瀏覽器分頁。
- 「每日學習提醒」顯示已啟用。
- 「傳送測試通知」可以收到通知。
- 到達設定時間後，即使 PWA 已關閉，也會收到通知。
- Cloudflare Worker 的 Cron Trigger 顯示 `* * * * *`。

Cron Trigger 第一次建立或修改後，Cloudflare 官方說明可能需要最多約 15 分鐘才會完全生效。測試通知不依賴 Cron，可先用它確認訂閱與 VAPID 設定。

## 十、常見問題

### 顯示「Origin not allowed」

檢查 `wrangler.toml` 的 `ALLOWED_ORIGINS`。GitHub Pages 專案即使有 Repository 路徑，Origin 仍只填：

```text
https://YOUR_GITHUB_USERNAME.github.io
```

修改後重新執行：

```powershell
npm run worker:deploy
```

### 測試通知可以收到，但定時通知沒有出現

依序確認：

1. 剛建立的 Cron 是否已等待約 15 分鐘。
2. Cloudflare Worker → Triggers 是否存在 `* * * * *`。
3. iPhone 是否有網路。
4. iOS 的專注模式、通知摘要是否延後通知。
5. PWA 設定頁顯示的時區是否正確。

### iPhone 沒有跳出允許通知視窗

- 必須先加入主畫面，並從主畫面開啟。
- 權限要求必須由使用者按「儲存並啟用」觸發。
- 若以前按過不允許，到 iPhone **設定 → 通知 → 英文複習**重新開啟。

### 使用自訂 Worker 網域

目前 `index.html` 的 CSP 已允許 `https://*.workers.dev`。若 Worker 改用自訂網域，必須把該網域加入 `index.html` 的 `connect-src`，否則瀏覽器會阻擋連線。

## 官方參考

- [Apple／WebKit：iOS 與 iPadOS 主畫面 Web App 的 Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [Cloudflare：Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare：GitHub Actions 部署 Workers](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare：D1 定價與免費方案](https://developers.cloudflare.com/d1/platform/pricing/)
