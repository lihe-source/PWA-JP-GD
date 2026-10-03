# 日文練習架構 V1.6.0

GitHub main 基準 commit：`5747ae6fc099cde4fda9268ee8e49ca713d9ce9e`（V1.5.4）。本版僅交付完整扁平 ZIP，不更改遠端資料。

## 模組

| 模組 | 責任 |
|---|---|
| app.js | 原有路由、練習畫面、生成／資料服務與 Drive 串接 |
| auth-client.js | 持久裝置工作階段、首次授權、背景恢復、登出與 Drive Proxy |
| auth-service.js | Worker 授權碼交換、PKCE、加密憑證、D1 租約續期與撤銷 |
| audio-manager.js | 設定還原、同步發音、utterance 保存、舊事件隔離與診斷 |
| backup-tasks.js | 懶載背景 Worker，attach／serialize／parse／validate／compare |
| storage.js | KV／records、交易式還原、失敗提示、遷移與復原點 |
| backup-schema.js | schema 1–3、checksum、類型／大小限制與完整集合比較 |
| learning-sync.js / study-streak.js | 裝置獨立雲端檔、答案聯集、日期去重 |
| handwriting-engine.js / kana-strokes.js | 增量繪製、筆順、換題復用 canvas |
| daily-learning.js | 全部發音行驗證、例句檢查、目標詞分段／反藍 |
| kana-reading.js / word-reading.js | 輸入比對、錯題補練與歷史 |
| reminder-manager.js / worker.js | 推播、當日已練判斷、排程與新增授權路由 |
| version-manager.js / sw.js | 閒置檢查、跨分頁保護和完整離線依賴 |

## 啟動與授權

IndexedDB 初始化後才還原 TTS、排序與裝置工作階段；首頁先渲染，網路、Service Worker 註冊與 badge 不阻擋。啟動不載入 GIS、不呼叫 requestAccessToken、不開授權視窗。正在練習時延後背景登入／比較、雲端資料合併與更新啟用。

首次授權按鈕在 await 前開視窗以保留 iOS 使用者手勢。前端 proof 綁定結果，後端 PKCE 保護 Google authorization code；callback 用 D1 compare-and-swap，只允許一次交換。callback 的 HTML／URL／postMessage 不傳 token。

Google 憑證以 AES-GCM、隨機 IV 和帳號綁定 additionalData 加密；D1 只保存裝置憑證的 SHA-256。續期以 isolate single-flight 加 D1 revision／20 秒租約保護，過期租約可恢復，舊續期不能覆蓋新授權。invalid_grant 只標記需重新連結。

Drive Proxy 限定 Google Drive v3 備份／學習檔 list、GET、multipart POST、media PATCH；不接受任意網域、DELETE 或權限操作。Origin 限 APP_URL 來源、無 Cookie、no-store、上傳有限制，access token 遭拒時有一次受控續期重試。登出或帳號變更透過 epoch 隔離舊回應，備份只包含明確 allowlist。

## 資料不變項

- 同一 IndexedDB 名稱、前綴和 object stores，備份 schema 不改。
- sentenceLog 先完整提交逐筆 records，再刪舊 KV；失敗保留來源、唯讀提示。無 ID 舊紀錄以穩定內容 fingerprint 加重複序號，保留全部歷史例句。
- 每次生成以獨立 ID 保存，同日多筆不覆蓋；相同 ID 重試 idempotent。例句／詞收錄仍在同一安全交易中提交。
- 同詞只補缺欄位，保留原 ID、加入時間、錯誤次數與權重。
- 還原先驗證、建立復原點、檢查本機變動與練習狀態；衝突不自動覆寫。
- 自動發音沿用 kanaPracticePreferencesV1.autoSpeak；新增 spellingEnabled 在合併模式保留既有本機選擇。
- 所有 Google 憑證、secret、裝置工作階段和通知訂閱都不進備份。

## 手寫、音效與 PWA 規範

- 開始、下一題和重播直接同步 speak；語音清單為空也使用系統 ja-JP 預設，voiceschanged 只更新快取，不重播。
- 關閉／換題／離開取消舊語音，舊回應不改新題。答題 Web Audio 音效與手寫發音開關分開。
- 評分只更新預留區，不導航、不重建 DOM、不變 canvas 尺寸、不強制捲動。保留完成總結。
- 沿用確認的藍色 UI、方形 PNG icon、英文主題式貼底導覽。保留 viewport，不新增 viewport-fit=cover、不重複累加 safe-area。
- 評分按鈕使用實際 reserved row，手機 session body 可捲動，不能蓋住畫布／分數。
- 所有前端依賴和背景備份 Worker 使用 V1_6_0，列入 SW APP_SHELL；auth-service.js 僅在 Cloudflare 使用。
- 保留啟動閒置自動檢查與設定頁目前／最新版本及檢查按鈕。
- 55 個平面檔案：原 49 個，加 4 個模組與 2 個測試檔；不提交 node_modules、dry-run 產物、截圖、secret、舊版副本。ZIP 與外層資料夾同名。

## 驗證與後續範圍

157 項測試覆蓋生成驗證、完整行過濾、歷史聯集、交易回滾、50 題引擎復用、OAuth 模擬、並行續期、登出競態、例句遷移與背景備份；另進行 Worker dry-run。版面沿用已確認的樣式；本次環境無法啟用瀏覽器，手機／平板視覺與操作尚未完成實機驗證。

實際 Google／Cloudflare 帳號、iOS 播放和 Apple Pencil 要發布後實機確認。後端一次設定見 README。

本版優先完成啟動、登入、發音、設定與備份／例句效能。app.js 尚未全部拆分；vocabWords、practiceHistory、文章和 AI 問答仍以 KV 保存。大型還原主執行緒交易仍有記憶體複製成本。

後續依實際量測分批加入歷史分頁、更多 records 集合、Views／DB 拆分、Worker CSV／ZIP 匯出及 CSS 去重。每次保留舊資料與完整備份、跑相關回歸測試，避免同版同時重寫儲存、手寫和整體 UI。
