# 台北火燒雲預報網站（taipei-burning-sky）設計文件

日期：2026-08-05
狀態：已與使用者確認之設計

## 目的

一個零維護的靜態網站，每日兩次（台北時間 15:00 與 23:30）自動更新，預測台北市下一場日落與日出出現火燒雲（雲彩被染成紅橙色的霞光）的機率，供攝影與觀賞安排參考。

- 15:00 更新 → 主要服務「今天日落」的預測
- 23:30 更新 → 主要服務「明天日出」的預測
- 每次更新同時重算兩場事件與未來 3 天趨勢

## 架構總覽

**平台**：GitHub Pages（靜態網站）+ GitHub Actions（排程計算）。
**資料來源**：Open-Meteo Forecast API 與 Open-Meteo Air Quality API（免費、免金鑰）。
**資料流**：Actions cron → `scripts/update.mjs`（抓 API → 算分 → 寫 JSON）→ commit 回 main → Pages 自動重新部署。網頁為純靜態單頁，載入 `data.json` 與 `history.json` 呈現。

已評估並否決的替代方案：純前端即時抓取（無法保存歷史紀錄、演算法暴露、無固定更新時刻概念）。

## Repo 結構

```
taipei-burning-sky/
├── .github/workflows/update.yml   # cron 排程 + workflow_dispatch 手動觸發
├── scripts/
│   ├── update.mjs                 # 主流程：抓資料 → 呼叫 score → 寫 JSON（Node 20，零外部依賴）
│   ├── score.mjs                  # 純函式評分模組（可獨立單元測試）
│   └── score.test.mjs             # node --test 單元測試
├── docs/                          # GitHub Pages 發佈根目錄
│   ├── index.html                 # 單頁網站（內嵌 CSS/JS，無建置步驟）
│   ├── data.json                  # 最新預測
│   └── history.json               # 歷史紀錄（append-only）
├── docs/superpowers/specs/        # 設計文件（本檔）
└── README.md
```

## 排程

GitHub Actions cron 以 UTC 表示：

| cron（UTC） | 台北時間 | 主要用途 |
|---|---|---|
| `0 7 * * *` | 15:00 | 今天日落預測 |
| `30 15 * * *` | 23:30 | 明天日出預測 |

另提供 `workflow_dispatch` 手動觸發。已知限制：GitHub Actions cron 可能延遲 3–15 分鐘，屬可接受範圍。Workflow 需 `contents: write` 權限以 commit 結果；連續兩次資料相同時（罕見）以 `git diff --cached --quiet` 判斷跳過空 commit（`git add` 之後須看暫存區，不帶 `--cached` 會永遠 quiet）。

## 評分演算法（0–100 分）

位置定為台北市中心（25.04°N, 121.56°E）。從 Forecast API 取每小時 `cloud_cover_low`、`cloud_cover_mid`、`cloud_cover_high`、`relative_humidity_2m`、`visibility`、`precipitation_probability`，daily 取 `sunrise`、`sunset`；從 Air Quality API 取每小時 `aerosol_optical_depth`。各變數以事件時刻（日出/日落當下）前後整點做線性插值。

五因子加權，總分 100：

| 因子 | 權重 | 計分邏輯 |
|---|---|---|
| 中高雲畫布 | 40 | 取 mid+high 合成雲量（上限 100）。鐘形曲線：25–60% 給滿分區間，0% 與 ≥95% 趨近 0 分 |
| 低雲阻擋 | 25 | 低雲量 0% 得滿分，隨低雲量線性遞減；≥70% 得 0 分 |
| 空氣通透度 | 15 | 濕度與能見度合成：濕度 ≤60% 且能見度 ≥20km 滿分；濕度 ≥95% 或能見度 ≤5km 趨近 0 |
| 氣溶膠 AOD | 10 | AOD 0.05–0.3 為理想區間給高分；>0.7 灰濛趨近 0；極低（<0.02，罕見）微扣 |
| 降雨干擾 | 10 | 事件時刻降雨機率 0% 滿分，線性遞減至 80% 以上 0 分 |

實作備註：權重與曲線斷點集中定義於 `score.mjs` 頂部常數，便於日後依實際準確度微調。

**等級標籤**：0–24 別期待｜25–49 普通｜50–74 值得一看｜75–100 大燒預警。

**輸出結構**：每場事件含總分、等級、事件時刻（ISO 含時區）、五因子各自的（實測值、得分、滿分、一句白話理由）。

## 資料格式

`data.json`：

```json
{
  "generatedAt": "2026-08-05T07:02:11Z",
  "trigger": "sunset-run",
  "next": {
    "sunset": { "eventTime": "…+08:00", "score": 62, "level": "值得一看", "factors": [ { "key": "canvas", "name": "中高雲畫布", "value": "48%", "score": 34, "max": 40, "reason": "…" } ] },
    "sunrise": { "…": "同結構" }
  },
  "outlook": [ { "date": "2026-08-06", "sunrise": { "time": "…", "score": 41 }, "sunset": { "time": "…", "score": 55 } } ]
}
```

`history.json`：陣列，每次執行 append 一筆 `{ ranAt, trigger, sunriseScore, sunsetScore, sunriseTime, sunsetTime }`。頁面只顯示最近 14 筆；檔案本身不裁切（純文字量極小，多年也僅數百 KB）。

## 頁面 UI

單頁、繁體中文、深色天空漸層視覺、手機優先。無框架、無建置步驟，CSS/JS 內嵌於 `index.html`。

由上而下：

1. **主卡**：依當下時間自動判斷下一場事件（現在時刻 < 今日日落 → 顯示日落，否則顯示明早日出）。大字分數、等級標籤、事件時刻、距今倒數。
2. **副卡**：另一場事件的縮小版。
3. **因子拆解**：五條橫桿（得分/滿分比例），各附實測值與白話理由。
4. **趨勢**：未來 3 天日出/日落分數小卡橫排。
5. **歷史**：最近 14 筆預測紀錄表格。
6. **頁尾**：資料產生時間、Open-Meteo 來源聲明、演算法說明摺疊區。

資料過期提示：`generatedAt` 距今超過 16 小時，頁首顯示過期警示色（排程最大間隔 15.5 小時，門檻須高於此值才不會每天誤報）。

## 錯誤處理

- API 抓取失敗：重試 3 次（1s/4s/9s 遞增間隔）。仍失敗 → 腳本以非零碼結束，Actions 標紅（GitHub 預設寄失敗通知信），不寫入任何 JSON——舊資料保持完整，不會被半套壞資料覆蓋。
- 兩個 API 其一成功其一失敗：視為整次失敗（AOD 缺漏會使分數失真且不可比較）。
- 頁面載入 JSON 失敗：顯示錯誤訊息與重試按鈕，不顯示空白頁。

## 測試

- `score.mjs` 為純函式（氣象數值入 → 分數與拆解出），以 `node --test` 覆蓋：無雲、全陰、低雲滿天、理想火燒雲情境、極端 AOD、降雨、插值邊界（事件時刻恰為整點）。
- CI：workflow 內於算分前先跑 `node --test`，測試失敗即中止不更新資料。
- 端對端：部署後以 `workflow_dispatch` 手動觸發一次驗證全流程。

## 部署步驟（一次性）

1. 以 `gh` CLI 建立 `ymeroom/taipei-burning-sky` 公開 repo 並推送。
2. Repo 設定 Pages：Source = main branch `/docs` 目錄。
3. Actions 權限確認 workflow 可寫入 contents。
4. 手動 dispatch 一次產生首份資料。

## 非目標（YAGNI）

- 不做多城市支援（僅台北市中心單點）。
- 不做推播/通知。
- 不做帳號、留言、回報機制。
- 不做準確度自動驗證（歷史紀錄先存著，日後有需要再分析）。
