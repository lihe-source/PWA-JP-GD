# V7.4.2 部署方式

ZIP 解壓後為 `PWA-Vocabulary-GD-V7_4_2`，資料夾內全部檔案維持扁平結構。

## GitHub Pages

1. 解壓 `PWA-Vocabulary-GD-V7_4_2.zip`。
2. 進入同名資料夾並選取全部檔案。
3. 上傳到 `lihe-source/PWA-Vocabulary-GD` 的 `main` 分支根目錄。
4. 等候 GitHub Pages 部署完成。
5. 完全關閉舊 PWA 後重新開啟，在設定頁確認目前版本為 V7.4.2。

不需清除網站資料。第一次開啟會自動檢查更新，Service Worker 只會在資料寫入及學習工作安全時更新。

## Cloudflare Worker

若要讓 Worker 顯示相同版本，於專案資料夾執行：

```bash
npm install
npm run worker:deploy
```

沿用原有 Worker 名稱、D1 Database ID 與 VAPID Secrets，不需重建資料庫。

## 驗證

```bash
npm run check
npm test
```
