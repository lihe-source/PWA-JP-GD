# V1.0.0 更新紀錄

## 日文化

- 將介面、資料欄位、通知、匯出檔名與 Gemini 提示改為日文學習情境。
- 語彙資料支援假名讀音、羅馬拼音、詞性、繁體中文與 JLPT N5～N1。
- 日文 TTS 使用 `ja-JP`，輸入比較支援全形正規化及平／片假名轉換。
- 新設計藍色系 PWA Icon 與完整藍色視覺主題。

## 五十音手寫

- 新增 46 平假名與 46 片假名，共 92 字。
- 新增描寫、臨摹、默寫、筆順動畫、復原、清除與提示。
- 支援 Apple Pencil 壓力、Pointer Events 與觸控防誤畫處理。
- 新增本機筆畫形狀、順序、方向、端點與平衡輔助評分。
- 新增手寫統計、弱項練習、CSV 匯入匯出及跨裝置同步。

## 資料與備份

- 新增日文專用 IndexedDB `pwa_japanese_v1` 與 `pwa_japanese:` 本機前綴。
- 完整備份 Schema 1 包含手寫、假名熟練度、練習天數與偏好。
- Google Drive 使用 `japanese_backup_*.json` 與 `japanese_learning_state.json`。
- 預設指定日文專用 Drive 資料夾，不混入英文資料。

## 部署與通知

- GitHub Pages Repository 預設為 `PWA-Japanese-GD`。
- Worker 名稱改為 `japanese-daily-reminder`。
- D1 使用獨立資料表 `japanese_reminders`，可安全沿用既有 D1 Database。
- Worker 健康檢查增加各設定項目的布林狀態，便於排除 `configured: false`。
- 保持完全扁平化檔案結構，方便手機一次上傳。
