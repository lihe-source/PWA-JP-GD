# V1.2.8 已內建設定

## Google

| 項目 | 內容 |
|---|---|
| OAuth Client ID | `171837667604-mtcf91qudt6ff79u382v37rjqpp7l51q.apps.googleusercontent.com` |
| Google Drive 資料夾 ID | `1kAtVOK2qqhK0BY9vmp8Sm4NhQaWMJYeb` |
| OAuth JavaScript 來源 | `https://lihe-source.github.io`（需在 Google Cloud Console 確認） |
| Gemini Key | 基於安全未寫入檔案，可與英文版使用同一把 |

## GitHub Pages 與推播

| 檔案 | 已設定內容 |
|---|---|
| `wrangler.toml` | Worker `japanese-daily-reminder`、每分鐘 Cron、日文 Pages URL、允許來源與既有 D1 Database ID |
| `push-config.js` | Worker URL `https://japanese-daily-reminder.rexchre.workers.dev`、預設提醒 22:00 與日文通知文字 |
| `schema.sql` | 獨立的 `japanese_reminders` 資料表；不會改動英文版 `reminders` |
| `worker.js` | V1.2.8 日文提醒、Apple 錯誤辨識、失效訂閱清除與測試通知自動修復；本版未變更資料表，若要讓 Worker 根網址同步顯示新版，只需重新執行部署，不必再次初始化 D1 |

如果 Cloudflare 帳號的 workers.dev 子網域不是 `rexchre`，請在第一次部署後把 `push-config.js` 的 `apiBaseUrl` 改成終端機顯示的實際網址，再上傳該檔案到 GitHub。

## 不應打包的機密

- Gemini API Key。
- VAPID Private Key。
- Cloudflare API Token 或登入資料。

VAPID 公開／私密金鑰可以與英文 Worker 共用，但三個 Secrets 仍須設定到新的 `japanese-daily-reminder` Worker；Cloudflare Secrets 是以 Worker 為單位保存，不會因檔案中有相同名稱就自動帶入。

## 更新不會清除的資料

- 上傳新版靜態檔不會清除瀏覽器 IndexedDB。
- 重新部署同名 Worker 不會清除 D1。
- `schema.sql` 只會 `CREATE TABLE IF NOT EXISTS`，不會刪除既有提醒。
- OAuth Client ID 與 Drive Folder ID 已有預設值；使用者仍可在設定頁修改。
- V1.2.8 會記住 Google 帳號識別、首頁學習來源、JLPT 等級、每日推薦行別、上次練習模式、單字練習條件、五十音手寫設定，以及五十音讀音的假名類型、行別與重複次數；完整備份亦包含讀音答題記錄與學習偏好。
- Google Access Token 僅放在當次安全工作階段，不永久寫入備份或裝置資料；首次授權後會以無提示模式嘗試背景恢復。
