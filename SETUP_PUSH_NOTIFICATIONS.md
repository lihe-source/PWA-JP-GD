# GitHub Pages＋每日推播設定（V1.2.4）

PWA 關閉後，網頁本身無法持續計時。本專案使用 Cloudflare Worker＋D1＋Cron 在指定時間傳送 Web Push；每一台 iPhone／iPad／電腦都要各自啟用一次。

目前檔案已預設：

- Pages：`https://lihe-source.github.io/PWA-JP-GD/`
- Worker：`japanese-daily-reminder`
- 預期 Worker URL：`https://japanese-daily-reminder.rexchre.workers.dev`
- D1：沿用現有 `vocabulary-reminders` Database，但使用獨立資料表 `japanese_reminders`

## 一、在 GitHub Codespaces 終端機部署

1. 開啟 `https://github.com/lihe-source/PWA-JP-GD`。
2. 點 **Code → Codespaces → Create codespace on main**。
3. 等待終端機出現後依序執行：

```bash
npm install
npx wrangler login
npm run db:init
npm run worker:deploy
```

`npm run db:init` 只會建立 `japanese_reminders`，不會刪除英文版提醒。如果 D1 ID 不屬於目前登入的 Cloudflare 帳號，請參考本文「改用新的 D1」。

部署成功後終端機會顯示 Worker 網址。若不是 `https://japanese-daily-reminder.rexchre.workers.dev`，請把實際網址填入 `push-config.js` 的 `apiBaseUrl`，然後 Commit 回 GitHub。

## 二、設定 VAPID 三個 Secrets

可以使用與英文版相同的 VAPID 公開／私密金鑰；但因為日文版是新的 Worker，三個 Secrets 必須再輸入一次。

如果仍保存原本兩把 Key，直接執行以下命令並依提示貼上：

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

- `VAPID_PUBLIC_KEY`：原本 public key。
- `VAPID_PRIVATE_KEY`：與 public key 同一組的 private key。
- `VAPID_SUBJECT`：例如 `mailto:your-email@example.com`。

如果找不到原本的 private key，請重新產生完整的一組：

```bash
npm run vapid:generate
```

保存畫面中的 `publicKey` 與 `privateKey`，再執行上面的三個 `secret put`。產生新 Key 後，先前用舊 Key 建立的日文通知訂閱必須在各裝置重新按「儲存並啟用」。

Secrets 設定完成後再部署一次：

```bash
npm run worker:deploy
```

不要把 VAPID Private Key、Gemini Key 或 Cloudflare API Token 寫入任何 GitHub 檔案。

## 三、確認 `configured: true`

用瀏覽器開啟 Worker 根網址。正確結果類似：

```json
{
  "ok": true,
  "service": "Japanese Daily Reminder",
  "version": "V1.2.4",
  "configured": true,
  "checks": {
    "database": true,
    "vapidPublicKey": true,
    "vapidPrivateKey": true,
    "vapidSubject": true,
    "appUrl": true,
    "allowedOrigins": true
  }
}
```

如果 `configured` 為 `false`，直接看 `checks` 哪一項是 `false`：

| false 項目 | 排除方式 |
|---|---|
| `database` | 執行 `npm run db:init`，再重新部署 |
| `vapidPublicKey` | 執行 `npx wrangler secret put VAPID_PUBLIC_KEY` |
| `vapidPrivateKey` | 執行 `npx wrangler secret put VAPID_PRIVATE_KEY`；必須和公開金鑰同組 |
| `vapidSubject` | 執行 `npx wrangler secret put VAPID_SUBJECT`，輸入 `mailto:你的Email` |
| `appUrl` | 確認 `wrangler.toml` 的 `APP_URL` 是完整 HTTPS Pages 網址並重新部署 |
| `allowedOrigins` | 確認 `ALLOWED_ORIGINS = "https://lihe-source.github.io"` 並重新部署 |

## 四、Google Cloud OAuth

在 Google Cloud Console 開啟此 OAuth 2.0 網頁用戶端，確認「已授權的 JavaScript 來源」包含：

```text
https://lihe-source.github.io
```

這裡只填來源，不要填 `/PWA-JP-GD/`，也不要加結尾 `/`。如果英文版已用相同來源，通常不需要再新增。

## 五、在裝置啟用

### iPhone／iPad

1. 使用 Safari 開啟 `https://lihe-source.github.io/PWA-JP-GD/`。
2. 分享 → **加入主畫面**。
3. 從藍色「あ」主畫面圖示開啟 PWA。
4. 進入 **設定 → 每日學習提醒**。
5. 選時間 → **儲存並啟用** → 系統詢問時按 **允許**。
6. 按 **傳送測試通知**。

### 電腦

使用支援 PWA 與 Web Push 的瀏覽器安裝網站，允許通知後，在設定頁啟用及測試。

測試通知成功只代表訂閱、VAPID 與網路正常；定時提醒還需要 Cloudflare 的 Cron Trigger。新部署或修改 Cron 後可能需稍候才完全生效。

## 六、測試成功但時間到沒通知

依序確認：

1. Cloudflare Dashboard → Workers & Pages → `japanese-daily-reminder` → Triggers，Cron 是否為 `* * * * *`。
2. Worker 根網址的六個 `checks` 是否全部為 `true`。
3. 設定頁顯示的時區與「下次提醒」是否正確。
4. iPad/iPhone **設定 → 通知 → 日文練習** 是否允許通知。
5. 專注模式、排程摘要或低耗電設定是否延後通知。
6. 裝置是否有網路；Apple Push 由系統傳遞，PWA 可關閉，但裝置仍需連線。
7. 若剛更新 VAPID Keys，重新按「儲存並啟用」；V1.2.4 會自動汰換舊的 Apple 訂閱。

若測試仍失敗，先確認 Worker 根網址顯示版本也是 `V1.2.4`，再執行 `npx wrangler tail japanese-daily-reminder --format pretty`。V1.2.4 會在紀錄中顯示 Apple 的 `providerReason`，並對 `BadDeviceToken` 自動刪除失效資料、由前端重建訂閱後重送一次。

## 七、改用新的 D1（僅在現有 ID 無權限時）

執行：

```bash
npx wrangler d1 create japanese-reminders
```

將回傳的 `database_id` 填入 `wrangler.toml`，並把 `database_name` 改成 `japanese-reminders`。接著執行：

```bash
npx wrangler d1 execute japanese-reminders --remote --file=schema.sql
npm run worker:deploy
```

如果改用新資料庫，`package.json` 的 `db:init` 名稱也建議同步改成 `japanese-reminders`，方便日後維護。

## 官方文件

- GitHub Pages：[設定發布來源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- Google Identity：[取得 Web OAuth Client ID](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)
- Cloudflare Workers：[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- Cloudflare Workers：[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- Cloudflare D1：[Wrangler D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/)
- WebKit：[iOS／iPadOS 主畫面 Web App Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
