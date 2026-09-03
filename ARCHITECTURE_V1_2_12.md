# PWA Japanese GD V1.2.12 架構

## 版本

- 基底：完整 `V1.2.11`
- App：`V1_2_12`
- 顯示：`V1.2.12`
- PWA Cache：`Japanese-PWA-V1_2_12`
- Cloudflare Worker：`V1.2.12`（僅版本一致，通知與資料表邏輯未變更）

## 低延遲手寫路徑

1. `pointerdown` 建立筆畫、快取畫布位置並將 `drawnPointIndex` 歸零。
2. `pointermove` 讀取 `getCoalescedEvents()`，直接把有效座標與壓力加入目前筆畫，不再建立重複的線段物件。
3. 同一畫面更新週期只排入一個 `requestAnimationFrame`。
4. `_drawStrokeRange()` 將尚未顯示的連續取樣點合併為 Canvas 路徑；觸控為單一寬度，Apple Pencil 僅在筆壓寬度跨級時另開路徑。
5. `pointerup` 立即補完剩餘線段，再更新筆畫數；原始座標、壓力及評分資料都保留。
6. 書寫期間收到 `ResizeObserver` 事件時只設定 `resizePending`，抬筆後才依新尺寸完整重畫。

## 前景輸入與背景同步隔離

- `recordStudyActivity()` 繼續立即更新本機學習天數與待同步狀態。
- `scheduleStudyStreakSync()` 在 `.kana-writing-canvas` 或 `#kana-reading-answer` 存在時，每 2.5 秒重新檢查，不執行 Drive 下載及資料合併。
- 手寫結果頁移除輸入畫布後，以 0.9 秒延遲觸發一次同步；多題記錄會一起合併上傳。
- 若使用者中途離開或暫時離線，本機待同步旗標保留，之後既有啟動／連線流程仍會補同步。

## 資料與部署

- 五十音筆畫、評分權重、手寫歷史、讀音統計、學習天數及完整備份格式皆未變更。
- 設定頁保留當前／最新版本、手動檢查更新按鈕與開啟程式自動更新。
- GitHub Pages 維持完全扁平；Cloudflare Worker、D1、VAPID、OAuth、Gemini 與 Google Drive 資料夾沿用既有設定。
