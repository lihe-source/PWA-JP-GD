# V1.5.11 架構與驗收範圍

## 模組責任

- `app.js`：畫面與操作協調、既有練習及 Drive 業務流程。仍保留既有 vanilla JS 架構。
- `cloud-runtime.js`：session-only 憑證存取、HTTP 錯誤分類、有界讀取重試及備份回執大小核對。
- `storage.js`：IndexedDB、交易、失敗寫入與救援、單一寫入視窗及儲存健康狀態。
- `collection-store.js`：陣列的逐筆記錄、順序索引及分批讀取，不改動匯出備份格式。
- `learning-sync.js`：事件 ID 合併、刪除標記、裝置貢獻差異與同步收斂。
- `background-jobs.js` / `data-worker.js`：備份準備、驗證、比較；重用閒置 Worker，取消或失敗時銷毀。
- `settings-vault.js`：加密設定檔、嚴格 allowlist、差異及分類預覽、原子套用。
- 其餘日文出題、手寫引擎、發音、提醒、更新與 UI 共用模組沿用。

## 儲存契約

資料庫名稱仍為 `pwa_japanese_v1`，schema 由 2 升級至 3。`kv` 保存設定與集合順序；`items` 以 `[collection,id]` 為主鍵保存單字、例句及原本 JSON 陣列；`records` 繼續保存三種手寫／讀音紀錄；`snapshots` 保存還原前復原點。

遷移時先驗證原始陣列，於單一交易中寫入逐筆資料與順序，保存 `migration-v3:*` 原始來源後移除原集合 KV 值。重新開啟時依順序索引重建舊同步介面的 JSON，驗證筆數及 ID 完整性，失敗時進入唯讀／救援狀態。不使用 `deleteDatabase`，不更改紀錄原始加入時間。

一般寫入只變更不同內容或刪除的列；排序由獨立 ID 陣列控制，移動一筆不用修改所有列。全資料庫仍有記憶體快取，分批讀取可讓出主執行緒，不等同完全懶載入。後續若改為所有歷史按需查詢，須一起改造統計及同步介面，不應以未載入資料當空集合。

原子還原在 `kv`、`records`、`items` 同一交易提交，完成後才更新記憶體；提交失敗不公布成功。尚未寫入成功時不可自動更新重載。救援匯出保留原始資料及遷移來源，排除 API Key／OAuth token。

Web Locks 可用時持有單一寫入視窗鎖，第二視窗顯示關閉原視窗後重新載入提示。這是防覆寫策略，不是同時編輯合併；未支援 Web Locks 的環境仍不具備此保護。

## Google 與同步

登入憑證僅在 sessionStorage／記憶體；記住 Email 不代表 token 有效。Google SDK 預載，不在啟動時要求互動授權。同時授權共用同一 promise，過期需要使用者觸發；晚到的舊帳戶 callback 由 authEpoch 排除。一般登出不撤銷 Google grant；解除授權另行確認並檢查回應。

只對 GET / HEAD 的 429、500、502、503、504 最多重試兩次，尊重有界 Retry-After、取消與整體 deadline。上傳 POST 不自動重送，避免伺服器已接收但回應中斷造成重複檔案。完整備份必須收到 file ID 與相符 UTF-8 size 才標記完成；這不是端到端加密雜湊證明，檔案內容仍由既有備份 checksum 驗證。

跨裝置狀態與完整備份保持不同用途：狀態同步只有 studyDays、handwritingHistory、kanaReadingHistory、wordReadingHistory 及刪除標記。pending 是持久狀態，只有連線、授權與前景可執行時補同步，不保證關閉 PWA 後背景傳輸。

三種練習清除先原子保存 `collection:id` 刪除標記及清除集合。合併採 delete-wins，禁止同一舊 ID 復活；新練習有新 ID，仍正常加入。刪除標記寫入每裝置狀態與完整備份 preferences，並受既有 checksum 保護；舊版不識別標記，應全裝置更新。練習天數是另一份紀錄，不隨細項清除。

各裝置只發佈自己已有的貢獻加上本輪相對遠端的新資料。任一遠端檔案不可讀則停止寫回，保留本機資料。同步收斂仍以合併後本機／雲端狀態驗證，不使用僅比較筆數的自動覆寫。

## UI 與更新不變條件

- 帳戶與雲端在設定第一組；加密設定備份維持最底。
- iPhone 底部導覽貼底，安全區僅由既有 App／nav 計算；不額外疊加 padding 或 vh 補差。
- 手寫畫布不隨評分重建或縮放；分數顯示於同頁，整組結束有總結。
- 讀音鍵盤保留同一 input，換行可提交，答對／錯誤／完成音效沿用。
- 整組平假名／片假名選行及已儲存偏好不改變。
- 頁面內容字級及間距改善，但不以縮小點擊區或壓縮畫布來填空白。
- Service Worker 先讀自己完整預載的同 build index，version.json 仍網路查詢；不把新部署 index 混入舊 shell。正在練習、輸入、傳輸或寫入時不立即更新。

## 加密設定

維持格式 version 1、AES-256-GCM、PBKDF2-SHA256 600,000 次、隨機 salt/IV。設定四分類只覆寫勾選項目，其他用套用當下的本機值。任何匯入值以 textContent 呈現，API Key 僅標示有變更，不顯示內容。通知、Google token、單字及歷史不放入此加密設定檔。

## 驗證與限制

`npm run check` 與 `npm test` 194 項通過。測試覆蓋既有出題、備份、輸入、設定保存及新增錯誤分類、只讀重試、回執大小、憑證 fallback、刪除合併、貢獻差異及選擇性設定還原。

另外以 fake-indexeddb 驗證真實 StorageBridge 的 v2 seed → schema 3、順序／筆數一致、原子還原／中止、重新開啟與 10,000 筆編輯／重新排序後完整內容相等。這是儲存 API 模擬測試，不是 Safari 配額與裝置效能測試。

本次瀏覽器因執行環境無法建立所需程序通訊而未能啟動；沒有完成圖形端對端測試。iPhone／iPad 實機安全區、鍵盤、發音及真實 Google OAuth／Drive 上傳尚待部署驗收。

本版沒有新增後端 token 續期服務，也未實作大型備份斷點續傳、全面按頁懶載入或完整 CSS 重寫；避免把局部優化稱為整個系統已完全重構。

## 發佈

完整 ZIP 的外層目錄與 ZIP 同名，內部檔案單層。僅保留三份固定文件，不累積各版本文件／截圖；不含 node_modules、測試產物、密碼或個人備份。更新版本時同步 app、manifest、index、SW、import 查詢字串、package 及 version.json build。此版僅前端變更，不需重新執行 D1 schema 或 Worker deploy。
