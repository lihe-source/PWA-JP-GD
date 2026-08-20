# PWA Japanese GD V1.2.1 架構

## 1. 產品與版本

- 產品 ID：`pwa-japanese-gd`
- 顯示版本：`V1.2.1`
- PWA Cache：`Japanese-PWA-V1_2_1`
- 備份 Schema：`1`
- 預定 GitHub Pages：`https://lihe-source.github.io/PWA-Japanese-GD/`

## 2. 功能模組

| 模組 | 功能 |
|---|---|
| 主頁 | 今日例句、目前連續、歷史最久、累積練習天數 |
| 練習 | 日文語彙測驗、五十音手寫、閱讀理解、文章寫作、AI 問答 |
| 資料庫 | 日文表記、讀音、羅馬拼音、詞性、中文、JLPT 與匯入匯出 |
| 統計 | 練習紀錄、正確率、弱項與五十音熟練度 |
| 設定 | Gemini、Google Drive、提醒、JLPT、備份、資料管理與版本更新 |

## 3. 五十音手寫

- 字庫：平假名 46 字與片假名 46 字。
- 路徑：KanjiVG 相容開放資料轉換為本機向量筆畫，授權見 `KANJIVG-LICENSE.txt`。
- 輸入：Pointer Events，同時支援手指、滑鼠與 Apple Pencil；使用壓力值調整筆畫寬度。
- iPad：橫向時採左右雙欄，左側提示與字卡、右側大尺寸正方形畫布；按鈕具至少 44px 觸控高度。
- 模式：描寫、臨摹、默寫。
- 行別：使用可複選按鈕，可同時練習任意多個五十音行。
- 重複：可選 1、2、3、5 或 10 次；先為每個已選假名建立等量副本，再以「剩餘次數優先、同數量候選隨機」的平衡排題演算法產生序列。單選あ行並重複 5 次會產生 25 題，順序隨機且相同假名不會相鄰。
- 設定頁：手機常用選項採精簡單頁排列，版面與弱項優先收在可展開的進階設定，降低 iPhone 與 iPad 開始練習前的捲動距離。
- 偏好：練習模式、行別、假名類型、重複次數、書寫方式及裝置版面會保存在本機，並納入完整備份。
- 響應式版面：自動以觸控裝置短邊判斷 iPhone／iPad；另提供手動版面切換。iPhone 書寫時的「評分」採黏附操作，評分完成後立即回到評分卡下方的正常文件順序，兼顧可操作性與資訊完整性。
- 評分：完全在裝置上比較形狀、筆順、方向、端點及版面；分數為學習提示，不是 OCR 或書法鑑定。
- 同步：每次結果寫入 `handwritingHistory`，並衍生 `kanaProgress`。

## 4. 資料隔離

| 範圍 | 日文版識別 | 與英文版關係 |
|---|---|---|
| IndexedDB | `pwa_japanese_v1` | 獨立 |
| localStorage 前綴 | `pwa_japanese:` | 獨立 |
| Service Worker Cache | `Japanese-PWA-` | 獨立 |
| Drive 資料夾 | `1kAtVOK2qqhK0BY9vmp8Sm4NhQaWMJYeb` | 獨立 |
| Drive 完整備份 | `japanese_backup_*.json` | 獨立 |
| 跨裝置狀態 | `japanese_learning_state.json` | 獨立 |
| Worker | `japanese-daily-reminder` | 獨立 |
| D1 資料表 | `japanese_reminders` | 可共用 D1 Database，但資料表獨立 |

只會嘗試一次性帶入可安全共用的設定：Gemini Key、Gemini 模型與 OAuth Client ID；不會匯入英文單字、例句、測驗或天數。

## 5. Google Drive 同步

完整備份包含：

- 語彙、例句與加權資料。
- 語彙、閱讀、寫作與 AI 問答紀錄。
- 練習日期、五十音手寫嘗試與假名熟練度。
- JLPT 程度、發音延遲、Gemini 模型與練習選項等偏好。

跨裝置同步以集合合併方式處理練習日與手寫紀錄，避免較舊裝置直接覆蓋較新紀錄。OAuth Access Token 僅保存在工作階段，不寫入永久備份。

## 6. 每日通知

GitHub Pages 只負責靜態 PWA。關閉 PWA 後的排程由 Cloudflare Worker 的每分鐘 Cron 執行，D1 儲存各裝置提醒時間、時區與 Web Push 訂閱，VAPID 私鑰只放在 Cloudflare Secrets。

日文 Worker 使用 `japanese_reminders`，因此即使沿用英文版 D1 Database ID，兩個 Cron 也不會重複讀取或傳送對方的提醒。

## 7. 扁平化部署

所有執行檔、後端檔、測試與說明均位於 Repository 根目錄；沒有必須手動建立的子資料夾。`.nojekyll` 用來讓 GitHub Pages 原樣發布靜態檔案。
