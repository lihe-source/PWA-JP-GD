# PWA Japanese GD V1.2.13 架構

## 同層模組

| 模組 | 責任 |
|---|---|
| app.js | 頁面、練習流程、Google Drive API 整合 |
| handwriting-engine.js | 筆跡取樣、批次繪圖、輸入中斷恢復及本機輔助評分 |
| learning-sync.js | 純資料合併與可重入的同步流程；下載、上傳和本機寫入等待後重讀最新資料 |
| storage.js | 同步讀取暫存、非同步 IndexedDB 寫入、失敗追蹤／重試與持久化確認 |
| storage-status-ui.js | 狀態顯示、救援 JSON 匯出與驗證後合併匯入 |
| practice-lifecycle.js | 各練習／草稿的統一活動狀態與更新保護 |
| version-manager.js / sw.js / version.json | 新版本檢查、完整快取、安全啟用及重新載入 |
| worker.js / schema.sql / wrangler.toml | 原有 Cloudflare 推播服務；本版僅更新版本標示 |

## 儲存與同步

- 沿用 `pwa_japanese_v1` 資料庫與 `pwa_japanese:` 本機鍵名前綴，沒有刪除或重建使用者資料庫。
- `setItem()` 先更新暫存；真正寫入成功後清除對應失敗狀態。錯誤保留在狀態中，由 `flush()` 回報，不建立未處理的 rejected promise。
- 使用逐次寫入序號，避免較舊寫入的延遲結果覆蓋新寫入狀態。
- 同步以事件 ID 合併，採最多三次有界確認；仍有新答案時保留待同步狀態並排入後續同步。
- Drive 查詢限制在設定資料夾，讀取舊 `japanese_learning_state.json` 及新裝置檔。任何來源讀取失敗時停止本次寫回，避免將不完整資料發布為完整資料。
- 各裝置只更新自己的裝置檔，兩台不同裝置同時同步不會直接覆蓋彼此的檔案；完整跨裝置一致性須各端成功完成同步，並非即時資料庫交易。
- 舊版裝置不認得新裝置檔，應一併升級。相同瀏覽器多分頁不應同時操作同一份學習資料；跨分頁交易鎖並未列入本版。
- 備份沿用 Schema 1，新增讀音欄位維持向後相容。JSON 救援備份包含學習紀錄與學習偏好，不包含 Google access token、Gemini Key 或 VAPID 私密金鑰。

## 手寫與更新

- 移動事件僅加入新取樣，透過 requestAnimationFrame 合併繪製；不在每個移動事件清空整張画布。
- 取消／失去捕捉時保留已收到的有效線段、釋放輸入狀態；單點被取消時不產生假筆畫。
- 落筆停止示範動畫；完整重繪及 Resize 延後到筆畫結束。
- 沿用原始本機評分公式，將只依筆畫數計算的欄位正確標示為「畫數」。
- 新版本可以先下載，但練習、未完成草稿、雲端作業或未確認本機儲存時不能啟用／重載。恢復安全狀態後再完成更新。

## 保留設定

OAuth、Google Drive 資料夾、GitHub Pages、Cloudflare Worker URL、Cron 及 D1 Binding 詳列於 `CURRENT_SETTINGS_INCLUDED.md`。不生成、不重設任何雲端金鑰。
