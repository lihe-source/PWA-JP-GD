# PWA Japanese GD V1.2.4 架構

## 版本

- App：`V1_2_4`
- 顯示：`V1.2.4`
- PWA Cache：`Japanese-PWA-V1_2_4`
- Cloudflare Worker：`V1.2.4`

## 手寫自動發音流程

1. 使用者在五十音設定頁按下「開始手寫練習」。
2. 程式建立手寫題目、畫布與按鈕。
3. 若 `autoSpeak` 開啟，立即將當前 `kana.character` 交給日文 TTS。
4. TTS 設定 `lang = ja-JP`，優先選擇裝置上的日文聲線，沒有符合聲線時使用系統預設日文朗讀。
5. 使用者評分並按「下一個假名」後，重新執行步驟 2～4。
6. 離開手寫練習時呼叫 TTS stop，清除待播事件並停止朗讀。

## 偏好與備份

- `kanaPracticePreferencesV1.autoSpeak`：布林值，預設 `true`。
- 設定納入既有 Practice Preference Bundle，因此完整備份、ZIP 與 Google Drive 跨裝置還原均可保留。

## 既有架構

- Google 帳號維持無提示背景恢復，主畫面不等待 Google 或 Service Worker。
- GitHub Pages 提供靜態 PWA；Cloudflare Worker＋D1 提供每日推播。
- iPhone 15 Pro Max 與 iPad Air 11 吋繼續使用自動響應式書寫版面。

