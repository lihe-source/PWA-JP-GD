# V1.2.14 更新步驟

1. 在舊版設定頁先匯出學習資料備份。
2. 解壓 `PWA-Japanese-GD-V1_2_14-FLAT.zip`。
3. 將同名資料夾內的全部檔案上傳到 `lihe-source/PWA-JP-GD` 的 `main` 分支根目錄並覆蓋舊檔。
4. 等待 GitHub Pages 完成部署，重新開啟已加入主畫面的 PWA。
5. 到「設定 → 版本資訊」確認當前版本為 V1.2.14；若仍顯示舊版，按「檢查更新」。
6. 捲動到設定頁最下方，確認「資料保存」位於音效測試後方。

本版沒有修改通知後端或 D1 Schema，不需要執行 `db:init`，也不需要重新產生 VAPID Keys。若要讓 Worker 根網址同步顯示 V1.2.14，只需執行 `npm run worker:deploy`。
