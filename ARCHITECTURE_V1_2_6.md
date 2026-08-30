# PWA Japanese GD V1.2.6 架構

## 版本

- 基底：完整 `V1.2.5`
- App：`V1_2_6`
- 顯示：`V1.2.6`
- PWA Cache：`Japanese-PWA-V1_2_6`
- Cloudflare Worker：`V1.2.6`（通知邏輯維持 V1.2.4）

## 首頁學習來源

### 單字庫

1. 從使用者既有單字資料庫隨機抽取一個語彙。
2. Gemini 依設定的 JLPT 等級產生自然例句、完整假名與繁體中文翻譯。
3. 內容寫入既有每日例句快取與例句紀錄。

### 依等級學習

1. 讀取 `dailyLearningPreferencesV1` 的來源、JLPT 等級與複選行別。
2. Gemini 產生 1 個符合條件的日文推薦單字。
3. `daily-learning.js` 驗證讀音起始行、排除重複，並補齊羅馬拼音。
4. 以日期與設定簽章寫入 `todayDailyVocabularyV1`，同日同設定直接使用快取。
5. 首頁以響應式卡片顯示單字、假名、羅馬拼音、中文、詞性與發音按鈕。
6. 將推薦詞轉成既有單字格式，產生例句、完整假名與中文翻譯。
7. 例句寫入 `todaySentence` 與 `sentenceLog`；以日期及推薦詞去重，同一天不重複建立。

## 設定與備份

- `japaneseJlptLevel`：目前 JLPT N5～N1 等級。
- `dailyLearningPreferencesV1.source`：`database` 或 `level`。
- `dailyLearningPreferencesV1.rows`：`all` 或多個五十音行 ID。
- 設定加入既有 Practice Preference Bundle；完整 JSON、ZIP 與 Google Drive 備份／覆寫／合併還原皆可保留。

## 既有架構

- Google 帳號維持無提示背景恢復與快速 Drive 備份。
- 五十音手寫、每題自動發音、iPhone／iPad 響應式書寫版面均保留。
- GitHub Pages 提供扁平靜態 PWA；Cloudflare Worker＋D1 維持使用者自選時間的每日 Web Push。
