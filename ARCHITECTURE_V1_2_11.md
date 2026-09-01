# PWA Japanese GD V1.2.11 架構

## 版本

- 基底：完整 `V1.2.10`
- App：`V1_2_11`
- 顯示：`V1.2.11`
- PWA Cache：`Japanese-PWA-V1_2_11`
- Cloudflare Worker：`V1.2.11`（通知與資料表邏輯未變更）

## 手寫輸入與繪圖流程

1. `pointerdown` 快取畫布位置並建立目前筆畫，不進行整張重畫。
2. `pointermove` 讀取瀏覽器提供的 `getCoalescedEvents()`，保留有效取樣點與壓力值。
3. 新增線段存入 `pendingSegments`；不論同一幀收到幾次事件，只保留一個 `requestAnimationFrame`。
4. 畫面更新時 `_flushPendingSegments()` 只繪製新線段，不清除背景與歷史筆跡。
5. `pointerup` 立即補完尚未顯示的最後線段，再將完整筆畫交給既有評分資料結構。
6. 只有換題、復原、清除、顯示提示、筆順動畫、評分揭示或實際尺寸變更時，才呼叫完整 `_render()`。

## iPhone／iPad 畫布策略

- CSS 尺寸仍依響應式版面決定，iPhone 與 iPad Air 11 吋沿用既有單頁書寫配置。
- 內部像素倍率最高為 2 倍，且長邊不超過 1280 像素；避免 iPhone 3 倍 DPR 對正方形畫布造成不必要的像素工作量。
- 畫布保留 `touch-action: none`，另以 `contain: paint` 與 `overscroll-behavior: contain` 隔離繪圖更新及捲動手勢。
- Apple Pencil 使用原始壓力值；觸控維持固定壓力，掌觸抑制邏輯不變。

## 資料與相容性

- 每個筆畫仍保存標準化 109 × 109 座標、壓力與時間；本機評分的筆形、筆順、方向、端點及配置權重未修改。
- 五十音手寫歷史、學習天數、讀音統計及 Google Drive 備份格式未變更。
- GitHub Pages 維持完全扁平的靜態 PWA；Cloudflare Worker、D1、VAPID 與每日提醒均沿用現有設定。
