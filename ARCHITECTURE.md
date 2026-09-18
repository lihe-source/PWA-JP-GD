# 日文練習架構 · V1.4.3

V1.4.3 將 iPhone 五十音手寫評分改為「筆跡在上、分數在下」的同題檢視。書寫狀態保留大畫布；完成評分後，同一個 Canvas 轉成唯讀預覽尺寸，完整成績卡緊接在畫布下方，使用者不需開啟第二層內容。下一題操作列仍保留在底部導覽上方的獨立空間。

評分狀態保留同一個 HandwritingEngine 與筆跡資料，版面切換後只依新的可用尺寸重繪，不重新計分或清除 strokes。換題時移除評分狀態、回到捲動起點，再由既有 `_resetWriterQuestion()` 清除並載入下一個假名。iPad 寬版仍採左右分欄，不套用手機縮圖規則。

V1.4.1 在 V1.4.0 的資料可靠性基礎上，將每日例句拆成「模型最終輸出 → JSON 結構解析 → 語言與目標詞驗證 → 原子保存 → UI 顯示」。任何階段失敗都不會污染今日卡片、例句紀錄或 Google Drive 備份。舊版異常 AI 紀錄標記為隔離資料，仍隨原有 sentences 集合備份，但不進入正常顯示、匯出或練習。

同一日期、設定簽章與推薦詞使用 single-flight 請求；快速重複點擊只共用一個 Promise。回覆完成時再次比對日期、簽章與推薦詞，避免過期請求覆蓋新內容。模型最多兩次生成嘗試，並記錄不含 API Key、Token 或原始提示的最小診斷資料。

V1.4.0 將即時輸入、持久化與雲端同步分成三條路徑。手寫期間只在 Canvas 增量繪圖；每題完成後，手寫／讀音紀錄各追加一筆 IndexedDB record；練習結束後才允許 Drive 合併。長期紀錄不截斷，統計、備份與跨裝置合併都讀取完整資料。

IndexedDB 升至 Schema 2，新增 `records` store，原有 `kv` 與 `snapshots` 保留；V1.3.8 的兩份歷史陣列會在首次啟動自動、完整遷移。備份覆寫或合併先通過結構驗證，再以單一交易提交，失敗時不更新記憶體快取與同步時間。Worker 不需變更 D1 結構，只將同日完成時間改存最早值。發布包仍為 46 個同層檔案。

V1.3.7 的手寫練習在同一輪重用 Canvas，`_resetWriterQuestion()` 僅更新題目資訊；按鈕事件從目前索引取得題目。引擎即時繪製落筆墨點，移動仍採合併樣本及逐幀增量繪圖。標準筆畫取樣以路徑為鍵快取（上限 128 組），历史快取以原始儲存字串判斷失效，還原資料後會重新正規化。

`inputMode` 與 `diagnostics` 納入既有手寫偏好與備份。落筆期間延後外層版面切換；診斷僅儲存固定大小的彙總數值，不保留無限事件清單。既有同步閘門保留，每題仍立即交由本機儲存層保存。

V1.3.7 在 V1.3.4 基礎上加入「提醒前已完成練習則略過當日通知」。六種練習仍由同一個 `recordStudyActivity()` 寫入正式學習日，並非只靠開啟頁面；前端將完成時間非阻塞地同步至 Worker，Cron 發送前再依提醒時區核對。已驗證的 V1.3.3 貼底配置、五十音讀音隱藏提示與其他學習功能不變。

## 部署結構

同一層共 46 個檔案：25 個前端執行檔、5 個 Cloudflare／npm 檔、10 個測試檔、3 個授權檔、3 個固定說明檔。ZIP 外層資料夾與 ZIP 同名，但上傳 GitHub 時只上傳該資料夾內的檔案。

GitHub Pages 提供 HTTPS 靜態前端；Google Identity 提供授權，Google Drive 儲存備份與裝置學習狀態；Cloudflare Worker、D1、Cron 負責每日推播與完成狀態核對。V1.4.3 未變更 Worker 或 D1，因此更新本版不需執行 `db:init` 或重新部署 Worker。

| 檔案 | 責任 |
|---|---|
| index.html | 入口、CSP、viewport 安全區、導覽與載入模組 |
| app.js | 六種模式、首頁、Google Drive、統計、設定與路由 |
| style.css | 基礎元件與最後的 V1.3 藍墨設計層 |
| storage.js | 批量啟動讀取、KV／逐筆紀錄、原子交易、寫入追蹤與重試 |
| storage-status-ui.js | 狀態、救援備份、驗證後合併匯入 |
| backup-schema.js | 備份 Schema 2、容量／欄位／筆數／checksum 與產品隔離 |
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

使用新 V1_3_7 版本參數與獨立快取名稱；sw.js 仍完整預載前端依賴。開啟時檢查 version.json；先保存資料，再於非練習／非雲端作業狀態啟用及重載。設定頁保留目前版本、最新版本與手動檢查。V1.3.3 未改變此更新流程。

Cloudflare 新增 `POST /api/reminders/activity`。`japanese_reminder_scopes` 只保存匿名裝置 scope 與訂閱的對應；`japanese_practice_days` 保存當地日期、完成時間與活動類型。scope 由本機隨機值經 SHA-256 產生，Worker 不接收 Email 或 Google Token。Cron 先鎖定到期提醒，再查詢同 scope、同當地日期且完成時間不晚於原定提醒時間的紀錄；符合時直接排到隔天，不呼叫推播供應商。測試通知不套用此條件。

兩個新表以 `CREATE TABLE IF NOT EXISTS` 建立，不修改或清空 `japanese_reminders`。更新須執行 db:init 和 Worker deploy，但不用換 VAPID、Worker URL、D1 綁定或重新授權通知。離線完成會留在本機並於恢復連線後重試；若裝置直到提醒時間後仍無法連上 Worker，雲端排程無法預先得知該次完成。

## 測試邊界

本次以用戶提供的 V1.3.2 與綠色英文版並列截圖為依據：藍色外部留白已消失，但日文版按鈕下方空間仍較多。比對 https://github.com/lihe-source/PWA-Vocabulary-GD 的 index.html／style.css：英文版未指定 viewport-fit=cover，底部採 64px + env safe inset 的 fixed 列。V1.3.3 移植此邊界與導覽幾何設定，保留日文 UI、資料與手寫容器；未取得真機執行時的尺寸，仍須實機驗證。

保留 10 份測試檔，檢查資料合併、備份、輸入效能、出題、讀音、版本與配置；V1.3 調整版面契約測試。靜態斷言不取代 Safari／iPad 真機排版、Pencil 行為、Google OAuth、Drive 或推播端到端測試。未改的外部服務仍須以原部署帳號驗收。

## 後續檔案管理

固定更新這三份說明，不新增 ARCHITECTURE_V*、CHANGELOG_V*、QA_V*、UPDATE_V*。不打包 node_modules、暫存、錄影、設計提案大圖或 icon 原始大圖。46 是現階段基準，未來若有真正必要模組可增加，不為湊數犧牲功能、授權或測試。
