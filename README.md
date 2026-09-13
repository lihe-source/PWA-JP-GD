# PWA Vocabulary GD V7.4.2

手機優先的英文單字複習 PWA，整合 IndexedDB、Google Drive 備份、Gemini、跨裝置練習天數與 Cloudflare Web Push。

## V7.4.2 重點

- 修正重複首頁 ID 導致桌面雙重分欄；最大內容寬度調整為 1200px。
- 標題列與版本標籤防溢出，中等視窗改為兩欄練習卡片。

- 全新森林綠 UI、新書本 V icon、固定品牌列與貼底導覽。
- 深色、淺色及跟隨系統主題，首次使用預設深色。
- 主頁集中顯示 Google 狀態、七日練習、快速開始、四種練習與今日例句。
- iPad／電腦寬螢幕改用雙欄資訊配置。
- 單字庫每批顯示 80 筆，並安全輸出匯入文字。
- 草稿待存佇列、IndexedDB 已提交狀態與寫入失敗復原。
- 備份、還原、同步與本機匯入共用互斥工作管理。
- 備份 Worker 逾時後會終止並重新建立。
- 更新前必須完成資料寫入；版本檢查具有 12 秒逾時。
- 啟動時自動檢查更新，設定頁顯示目前／最新版本並提供手動檢查。

## 相容性

- IndexedDB：`pwa_vocabulary_v7`
- Backup Schema：V8
- 舊 V7 備份：可相容還原
- Service Worker Cache：`Voc-PWA-V7_4_2`
- Google Access Token：僅保存於 `sessionStorage`

## 驗證

```bash
npm run check
npm test
```

目前自動化測試：36/36 通過。部署步驟請見 `DEPLOY_V7_4_2.md`。
