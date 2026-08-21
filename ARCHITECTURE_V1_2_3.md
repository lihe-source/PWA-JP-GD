# PWA Japanese GD V1.2.3 架構

## 版本

- App：`V1_2_3`
- 顯示：`V1.2.3`
- PWA Cache：`Japanese-PWA-V1_2_3`
- Cloudflare Worker：`V1.2.3`

## 啟動順序

1. 初始化本機 IndexedDB 與學習資料。
2. 以非阻塞方式註冊 Service Worker。
3. 立即渲染主畫面，不等待 Service Worker 或任何 Google 網路要求。
4. 預載 Google Identity Services，但不要求使用者操作。
5. 350 ms 後於背景嘗試恢復既有 Google 工作階段：
   - 工作階段 Token 有效：直接使用。
   - 僅記住帳號：以 `prompt: none` 與 `login_hint` 無提示嘗試恢復。
   - 無法無提示恢復：安靜停止，主畫面及本機功能保持可用。
6. 取得有效 Token 後，才執行已啟用的 Drive 自動同步。

## Google 授權策略

- 首次連結：由設定頁按鈕啟動帳號選擇及授權。
- 日常開啟：不顯示登入確認畫面。
- 雲端操作：若已有帳號與授權，明確傳送空白 `prompt` 以跳過帳號選擇；若 Google 判定需要重新驗證，才顯示授權流程。
- Token：只存在記憶體與 `sessionStorage`，不寫入 IndexedDB、localStorage、ZIP 或 Google Drive 備份。

## 部署一致性

- GitHub Pages 提供靜態 PWA。
- Cloudflare Worker 提供定時通知，D1 保存裝置提醒。
- 每次升版均同步更新前端與 Worker 版本；靜態檔上傳後執行 `npm run worker:deploy`。
