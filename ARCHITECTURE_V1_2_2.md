# PWA Japanese GD V1.2.2 架構

## 發布資訊

- App 版本：`V1_2_2`
- 顯示版本：`V1.2.2`
- PWA Cache：`Japanese-PWA-V1_2_2`
- GitHub Repository：`https://github.com/lihe-source/PWA-JP-GD`
- GitHub Pages：`https://lihe-source.github.io/PWA-JP-GD/`
- Cloudflare Worker：`japanese-daily-reminder`

## 前端啟動順序

1. 載入 IndexedDB 快取與相容設定。
2. 註冊 Service Worker。
3. 立即顯示首頁並綁定導覽操作。
4. 非同步預載 Google Identity Services。
5. 背景恢復 Google 權杖、比較雲端備份及同步練習天數。
6. 閒置時檢查 `version.json`，有新版本且未在作答時自動安全更新。

任何 Google 或 Drive 網路延遲都不再阻塞首頁顯示。

## Google Drive 操作

- `GDrive._loadGIS()`：共用載入 Promise、輪詢完成狀態及載入逾時。
- `GDrive._fetch()`：統一處理網路錯誤、AbortController 與逾時。
- `GDrive.ensureToken()`：有效權杖直接使用；需要互動時只從原始點擊提出一次授權要求。
- `GDrive.upload()`：建立完整 Backup Schema 後先上傳，獨立練習狀態在背景同步。
- `GDrive.syncStudyStreak()`：跨裝置聯集合併，多檔案平行下載並保留雙重確認。
- 還原流程：下載、Schema 驗證、建立本機復原點、套用資料、等待 IndexedDB flush。

## 推播修復流程

1. PWA 向 Worker 傳送測試要求。
2. Worker 使用 VAPID 與 `aes128gcm` 傳送到瀏覽器 Push Service。
3. Apple 若回傳失效 Device Token，Worker 刪除對應 D1 紀錄並回傳 `SUBSCRIPTION_INVALID`。
4. PWA 取消舊 Push Subscription，使用同一 VAPID 公開金鑰建立新訂閱。
5. PWA 重新登記 D1 並自動重送測試一次。
6. 若為通知格式錯誤，設定頁顯示 Apple `providerReason`，Worker 即時紀錄亦保留原因。

## 資料隔離與安全

- 日文資料庫：`pwa_japanese_v1`。
- 本機鍵名前綴：`pwa_japanese:`。
- 日文提醒資料表：`japanese_reminders`。
- Google Access Token 僅保留於目前 PWA Session；帳號 Email、Client ID 與 Scope 用於快速恢復狀態。
- Gemini Key、VAPID Private Key 與 Cloudflare Token 不包含於 ZIP。
- 完整備份包含練習天數、五十音手寫、練習偏好與所有學習記錄。

## 扁平部署

所有 HTML、CSS、JavaScript、圖示、Cloudflare 設定、測試與說明檔均位於同一層。解壓後可直接全選並上傳到 GitHub Repository 根目錄。

