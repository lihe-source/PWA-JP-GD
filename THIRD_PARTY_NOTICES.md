# 第三方資料授權

本專案的基本平假名與片假名筆順路徑衍生自 **KanjiVG 5.0.0**。

- KanjiVG: https://kanjivg.tagaini.net/
- License: Creative Commons Attribution-ShareAlike 3.0
- 本專案只擷取基本五十音所需的向量路徑，並轉換為離線 JavaScript 資料格式。
- 完整授權文字請見 `KANJIVG-LICENSE.txt`。

## V1.6.0 App Icon

新版使用為本專案生成的摺紙鶴與朱紅日輪圖示，另輸出 Apple 主畫面與 maskable 尺寸。

## V1.5.13 voiced and semi-voiced kana

50 additional hiragana/katakana stroke definitions in `kana-strokes.js` are
adapted from KanjiVG (Ulrich Apel and contributors), fetched 2026-11-07 from:
https://github.com/KanjiVG/kanjivg/tree/610091ce618cf757ed1357a8954cd65283e015d6/kanji

The SVG path data and initial points are converted to offline JavaScript JSON.
These derived stroke definitions retain CC BY-SA 3.0 attribution and terms;
see KANJIVG-LICENSE.txt. Existing basic kana paths are unchanged.
