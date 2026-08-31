# PWA Japanese GD V1.2.7 架構

## 版本

- 基底：完整 `V1.2.6`
- App：`V1_2_7`
- 顯示：`V1.2.7`
- PWA Cache：`Japanese-PWA-V1_2_7`
- Cloudflare Worker：`V1.2.7`（通知邏輯維持 V1.2.4）

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

## 五十音讀音練習

1. 練習模式選單在「五十音手寫」下方新增「五十音讀音」。
2. `kana-data.js` 提供平假名、片假名與十個行別，讀音模式與手寫模式共用相同課程資料。
3. 使用者可選平假名、片假名或兩者混合，並複選「あ／か／さ／た／な／は／ま／や／ら／わ」行。
4. 題目顯示假名，使用者以羅馬拼音作答；`kana-reading.js` 負責正規化與常用拼音別名判定。
5. `kanaReadingHistory` 保存每題答案、正誤、假名類型、行別與時間，統計頁分別呈現平假名、片假名正確率。
6. 備份 Schema 升至 2；仍可讀取 Schema 1 的舊備份，新紀錄可透過 ZIP 與 Google Drive 還原。

## 既有架構

- Google 帳號維持無提示背景恢復與快速 Drive 備份。
- 五十音手寫、每題自動發音、iPhone／iPad 響應式書寫版面均保留。
- GitHub Pages 提供扁平靜態 PWA；Cloudflare Worker＋D1 維持使用者自選時間的每日 Web Push。
