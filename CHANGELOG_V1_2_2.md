# V1.2.2 更新內容

## iPhone／iPad Web Push

- Worker 明確使用 `aes128gcm` 傳送加密內容，移除 Apple 可能拒絕的 Web Push Topic 標頭。
- 解析 Apple Push Service 回傳內容，健康紀錄會保留 HTTP 狀態與 `providerReason`。
- `BadDeviceToken`、`DeviceTokenNotForTopic`、404、410 會自動從 D1 移除失效訂閱。
- 測試通知遇到失效訂閱時，PWA 會自動執行 `unsubscribe()`、建立新訂閱、重新登記 D1 並重送一次。
- 使用者再次按「儲存並啟用」時，若裝置已有提醒設定，會強制汰換舊訂閱。
- 按「關閉提醒」時同時移除伺服器狀態、本機管理憑證及瀏覽器 Push Subscription。

## Google 登入與 Drive 效能

- Google Identity Services 改為頁面開啟時非同步預載，加入 preconnect。
- 修正 GIS Script 已載入但事件錯過時可能永久等待的問題，增加輪詢與 12 秒逾時。
- 首頁先完成顯示，權杖恢復、自動同步與雲端比較改在背景執行。
- 取得 Google 帳號 Email 改為背景作業，不再阻塞登入完成。
- 手動操作只提出一次權杖要求，避免 Safari 因失去點擊手勢而阻擋第二個登入視窗。
- 完整備份先直接上傳，練習天數獨立同步改在背景執行，不再於上傳前等待多輪同步。
- 多個練習狀態檔改為平行下載。
- Drive API 加入 20 秒一般逾時與 45 秒上傳逾時。
- 登入、上傳、清單讀取、下載及還原都有按鈕狀態、階段文字與百分比提示。
- 還原前先顯示處理狀態並讓瀏覽器完成一次畫面更新，再執行資料合併與 IndexedDB 寫入。

## 部署與版本

- App、Manifest、Service Worker Cache、模組查詢字串與版本檢查統一升級至 `V1.2.2`／`V1_2_2`。
- Worker 健康檢查版本升級至 `V1.2.2`。
- `wrangler.toml` 的正式 Pages 網址修正為 `https://lihe-source.github.io/PWA-JP-GD/`。
- 保持 ZIP 與解壓資料夾同名、所有部署檔完全扁平化。

## 驗證

- JavaScript 語法檢查通過。
- 32 項自動測試通過，包含版本一致性、通知自動修復、Drive 非阻塞啟動、手寫練習及備份資料完整性。

