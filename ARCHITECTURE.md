# 日文練習架構 · V1.3.5

V1.3.5 在 V1.3.4 基礎上加入「提醒前已完成練習則略過當日通知」。六種練習仍由同一個 `recordStudyActivity()` 寫入正式學習日，並非只靠開啟頁面；前端將完成時間非阻塞地同步至 Worker，Cron 發送前再依提醒時區核對。已驗證的 V1.3.3 貼底配置、五十音讀音隱藏提示與其他學習功能不變。

## 部署結構

同一層共 46 個檔案：25 個前端執行檔、5 個 Cloudflare／npm 檔、10 個測試檔、3 個授權檔、3 個固定說明檔。ZIP 外層資料夾與 ZIP 同名，但上傳 GitHub 時只上傳該資料夾內的檔案。

GitHub Pages 提供 HTTPS 靜態前端；Google Identity 提供授權，Google Drive 儲存備份與裝置學習狀態；Cloudflare Worker、D1、Cron 負責每日推播與完成狀態核對。本版新增完成回報 API 及兩個 D1 輔助表，因此更新後須執行 `db:init` 與重新部署 Worker。

| 檔案 | 責任 |
|---|---|
| index.html | 入口、CSP、viewport 安全區、導覽與載入模組 |
| app.js | 六種模式、首頁、Google Drive、統計、設定與路由 |
| style.css | 基礎元件與最後的 V1.3 藍墨設計層 |
| storage.js | 記憶體快取、非同步 IndexedDB、寫入追蹤與重試 |
| storage-status-ui.js | 狀態、救援備份、驗證後合併匯入 |
| backup-schema.js | Schema 1、checksum 與產品隔離 |
| study-streak.js | 日期／時區、連續紀錄、事件去重與合併 |
| japanese-learning.js | 預設設定、正規化、手寫進度与版面判斷 |
| daily-learning.js | JLPT、五十音行、每日推薦與回應驗證 |
| learning-sync.js | 重入安全的多裝置學習合併 |
| practice-lifecycle.js | 練習、草稿與更新安全狀態 |
| kana-data.js / kana-strokes.js | 假名、筆畫資料、重複且不相鄰的隨機出題 |
| handwriting-engine.js | 取樣、增量批次繪圖、手掌處理與輔助評分 |
| kana-reading.js | 羅馬音判定、別名與讀音紀錄 |
| chart-renderer.js | 原有統計圖 |
| reminder-manager.js / push-config.js | 裝置訂閱、時間、完成回報、測試、錯誤與自動修復 |
| sw.js / version-manager.js / version.json | 離線快取、版本比較、安全啟用 |
| manifest.json / icon-192.png / icon-512.png | PWA 安裝與品牌 |
| jszip.min.js | 原有 ZIP 備份 |
| worker.js / schema.sql / wrangler.toml | 通知 API、D1 表及 Cron 綁定 |
| package.json / package-lock.json | 固定依賴與檢查、部署命令 |

## V1.3 介面

共用色票：文字 #16324F、主色 #2463D5、背景 #F3F7FC、卡片 #FFFFFF。主要元件 10–16px 圓角；主要觸控按鈕至少 44px，輸入欄位 16px；保留縮放與 reduced-motion。

### 首頁

真實學習日透過 dateKeyFor() 和 StudyStreak.getDays() 顯示本週狀態。推薦詞沿用每日一詞快取；只有該詞對應的例句完成產生／讀取後才顯示例句預覽。沒有 API Key 或資料時顯示真實空狀態，不塞入示意詞或示意天數。

首頁保留一般練習、手寫、讀音、資料庫、統計、設定與每日例句入口。帳號按鈕只前往設定，不觸發新的授權要求。所有動態資料經 HTML escaping。

### 手寫操作

- index.html 沿用英文版的預設 viewport fit（移除 cover，但不移植禁止縮放）。html／body／App 高度為 100%；不使用獨立的 vh／dvh 外框，不猜測 screen.height。App 維持正常文件流。
- 手機導覽固定在視窗 bottom: 0，height: calc(64px + safe-area-inset-bottom)，上方內距 6px、底部內距 0；預設 viewport 由瀏覽器安排安全邊界，CSS 仍保留 env fallback。
- App 的 padding-bottom 與導覽 height 使用同一算式，讓手寫的有限高度容器亦預留導覽空間；view-container 只有一般內容內距。寬度 >=900px 時 App 的 padding-bottom 歸零，側導覽仍 absolute 定位於 App。
- iPhone：session 為固定可用高度的 flex 容器；header 與 action 為不可壓縮列，只有 session-body 可捲動。評分前後使用同一操作列，不切換 sticky／floating 定位。
- iPad：data-layout=tablet 且寬度至少 760px 時，session 使用 grid；reference 在左上，score 在左下，canvas 在右側，action 在右下。
- 畫布外層為 size container，內部寬高同為 min(100cqw,100cqh)，維持實際正方形，不以 object-fit 製造視覺與輸入座標的差異。
- 自動模式沿用既有裝置與尺寸判斷。手動選 iPad 但視窗不足 760px 時，CSS 仍採安全單欄。
- 手機導覽由 App padding 預留位置；900px 以上是已預留寬度的側列。
- 示範動畫、評分、pointer capture、Apple Pencil、取消輸入恢复和 requestAnimationFrame 批次不變；只換視覺與容器。

### Icon

192／512 PNG 為不透明藍色背景，系統安裝時套用圓角或遮罩。白色「あ」使用專案內 KanjiVG 向量，附簡潔書本線條。相較生成提案，實際圖示使用可驗證假名字形且不依賴字型。

可用 kana-strokes.js 的 あ paths 重建：512 viewBox、漸層 #3282FA → #2463D5 → #1749A2；paths transform 為 translate(69 21) scale(3.43)，white stroke-width 6.7、round caps/joins；書本線為 M133 372 Q198 353 256 383 Q314 353 379 372，stroke #A9D0FF、13px。授權詳見 THIRD_PARTY_NOTICES.md。

## 儲存與同步不變

- 沿用 pwa_japanese_v1 與 pwa_japanese:，沒有 deleteDatabase 或資料遷移。
- 寫入序號避免舊失敗覆蓋新成功；flush 必須真正寫入完成。
- 跨裝置以事件 ID 合併、至多三次有界確認，未完成保留 pending。
- Drive 查詢限制在設定資料夾。任一來源讀取失敗會停止寫回，不把不完整合併當成功。
- 各裝置更新自己的狀態檔，仍讀取 legacy 共用狀態。跨裝置一致性需要各端完成同步，並非即時交易。
- JSON／CSV／ZIP、checksum、回復點與錯誤處理保留。機密不寫入交付包。

## 更新與相容性

使用新 V1_3_5 版本參數與獨立快取名稱；sw.js 仍完整預載前端依賴。開啟時檢查 version.json；先保存資料，再於非練習／非雲端作業狀態啟用及重載。設定頁保留目前版本、最新版本與手動檢查。V1.3.3 未改變此更新流程。

Cloudflare 新增 `POST /api/reminders/activity`。`japanese_reminder_scopes` 只保存匿名裝置 scope 與訂閱的對應；`japanese_practice_days` 保存當地日期、完成時間與活動類型。scope 由本機隨機值經 SHA-256 產生，Worker 不接收 Email 或 Google Token。Cron 先鎖定到期提醒，再查詢同 scope、同當地日期且完成時間不晚於原定提醒時間的紀錄；符合時直接排到隔天，不呼叫推播供應商。測試通知不套用此條件。

兩個新表以 `CREATE TABLE IF NOT EXISTS` 建立，不修改或清空 `japanese_reminders`。更新須執行 db:init 和 Worker deploy，但不用換 VAPID、Worker URL、D1 綁定或重新授權通知。離線完成會留在本機並於恢復連線後重試；若裝置直到提醒時間後仍無法連上 Worker，雲端排程無法預先得知該次完成。

## 測試邊界

本次以用戶提供的 V1.3.2 與綠色英文版並列截圖為依據：藍色外部留白已消失，但日文版按鈕下方空間仍較多。比對 https://github.com/lihe-source/PWA-Vocabulary-GD 的 index.html／style.css：英文版未指定 viewport-fit=cover，底部採 64px + env safe inset 的 fixed 列。V1.3.3 移植此邊界與導覽幾何設定，保留日文 UI、資料與手寫容器；未取得真機執行時的尺寸，仍須實機驗證。

保留 10 份測試檔，檢查資料合併、備份、輸入效能、出題、讀音、版本與配置；V1.3 調整版面契約測試。靜態斷言不取代 Safari／iPad 真機排版、Pencil 行為、Google OAuth、Drive 或推播端到端測試。未改的外部服務仍須以原部署帳號驗收。

## 後續檔案管理

固定更新這三份說明，不新增 ARCHITECTURE_V*、CHANGELOG_V*、QA_V*、UPDATE_V*。不打包 node_modules、暫存、錄影、設計提案大圖或 icon 原始大圖。46 是現階段基準，未來若有真正必要模組可增加，不為湊數犧牲功能、授權或測試。
