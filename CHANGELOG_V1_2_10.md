# V1.2.10 更新內容

本版依 iPhone 15 Pro Max 實機錄影重新設計五十音讀音的音效與鍵盤流程，基底為完整 V1.2.9。

## 音效修正

- 實機錄影顯示鍵盤系統聲存在，但答對、答錯與結果頁沒有 Web Audio 輸出。
- iOS／iPadOS Web Audio 改用 `navigator.audioSession.type = 'playback'`，避免預設 ambient 工作階段受到 Ring／Silent 模式靜音。
- 開始練習、鍵盤 Enter 與頁面按鈕操作都會再次確認 AudioContext 已解鎖。
- 答對、答錯、練習結束仍共用單字拼寫的 `playCorrect()`、`playWrong()` 與 `playResult()` 音效。

## 鍵盤常駐與單鍵換題

- 整段練習只建立一個羅馬拼音輸入框，切換題目時不再替換或停用輸入節點。
- 鍵盤換行／下一個鍵直接送出答案，不需要再點頁面上的「下一題」。
- 判定後保留 650ms 顯示答對／答錯資訊，接著自動清空欄位並顯示下一個假名。
- 下一題沿用原輸入焦點，所以 iPhone／iPad 鍵盤保持開啟；最後一題完成後才關閉鍵盤並顯示結果。
- 頁面主按鈕同步改為「送出並下一題／送出並完成練習」，仍可供不使用鍵盤 Enter 的使用者操作。

## 相容與部署

- App、Manifest、Service Worker Cache、模組查詢字串與 Worker 版本統一為 `V1.2.10`／`V1_2_10`。
- 未修改 D1、備份 Schema、Google Drive 或練習統計資料格式，不需要重新執行 `npm run db:init`。
