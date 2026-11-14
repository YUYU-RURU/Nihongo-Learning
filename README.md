# にほんご練習帳

三個分頁的日文學習網頁：50 音、N5 分類單字（含例句與發音）、YouTube 雙語字幕播放器。

## 檔案

- `index.html` — 整個網頁（樣式、程式、單字資料都在裡面）
- `netlify/functions/subs.mjs` — 抓 YouTube 字幕的 Netlify Function
- `netlify.toml` — Netlify 設定

## 部署到 Netlify

**要讓「自動抓字幕」能用，必須用 Git 或 CLI 部署**（拖曳上傳不會啟用 Function）。

- Git：把這個資料夾推到 GitHub → Netlify「Add new site → Import an existing project」→ 選該 repo → 直接 Deploy（不需 build command）。
- CLI：在這個資料夾執行 `npx netlify-cli deploy --prod`。

只拖曳上傳 `index.html` 也能用：50 音、單字、影片播放與調速、手動貼字幕都正常，只有自動抓字幕不會動。

## 新增單字

打開 `index.html`，找到 `const VOCAB={`，照格式加一列：

```
["單字","假名","中文","例句，漢字後面用[讀音]標假名","例句中文"],
```

要新增分類，就加一個新的 `"分類名稱":[ ... ],` 區塊。
