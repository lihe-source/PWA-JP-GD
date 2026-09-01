# 手機上傳到 GitHub

目標 Repository：`https://github.com/lihe-source/PWA-JP-GD/`

## 1. 解壓縮

1. 在 iPhone／iPad 的「檔案」App 找到 `PWA-Japanese-GD-V1_2_9-FLAT.zip`。
2. 點一下 ZIP，系統會建立解壓後的資料夾。
3. 打開資料夾；所有檔案都在同一層，不需新增子資料夾。

## 2. 上傳檔案

1. 用 Safari 登入 GitHub 並開啟 `lihe-source/PWA-JP-GD`。
2. 確認左上分支為 `main`。
3. 點 **Add file → Upload files → choose your files**。
4. 在檔案選擇器按右上角「選取」，一次勾選解壓後的全部檔案。
5. Commit message 輸入 `Release Japanese PWA V1.2.9`。
6. 選擇直接提交到 `main`，按 **Commit changes**。

若 Repository 內有舊檔而本次 ZIP 不再提供，GitHub 的一般上傳不會自動刪除舊檔。舊英文版 CHANGELOG 留在 Repository 不影響執行，但建議另外刪除，避免文件混淆。

`.nojekyll` 是隱藏檔，iOS 檔案選擇器可能不顯示；若 Repository 已有此檔可保留。即使無法從手機選到，純 HTML／JS／CSS 專案通常仍可發布。

## 3. 開啟 GitHub Pages

1. Repository 點 **Settings**。
2. 找到 **Pages**。
3. Source 選 **Deploy from a branch**。
4. Branch 選 `main`，Folder 選 `/(root)`，按 **Save**。
5. 等候部署完成後開啟 `https://lihe-source.github.io/PWA-JP-GD/`。

`index.html` 必須直接位於 Repository 根目錄；如果網址顯示 404，先確認沒有把全部檔案包在另一層資料夾裡。

## 4. 安裝到 iPhone／iPad

1. 必須用 Safari 開啟 GitHub Pages 網址。
2. 點分享按鈕 → **加入主畫面** → **加入**。
3. 從主畫面的藍色「あ」圖示啟動。
4. 到設定頁輸入 Gemini Key；Google Drive 的 OAuth Client ID 與資料夾 ID 已預設。
5. 若使用 Apple Pencil，建議 iPad 橫向進入 **練習 → 五十音手寫**。
6. 「書寫版面」預設為自動；若系統判斷不符合使用習慣，可固定選擇 iPhone 或 iPad 版面，程式會記住選項。

## 5. 更新後仍顯示舊版

1. 確認設定頁的版本是否為 `V1.2.9`。
2. 按設定頁的「檢查更新」。
3. 完全關閉 PWA 後重新開啟。
4. 若仍舊版，等待 GitHub Pages 部署完成後再試；不要先刪除網站資料，以免本機尚未同步的學習資料遺失。
