# 光路取樣 + 衛星驗證迴路 設計文件

日期：2026-08-06
狀態：已與使用者確認之設計
前置：初版網站已上線（見 `2026-08-05-taipei-burning-sky-design.md`），本文件為兩項準確度升級。

## 目的

1. **光路取樣**：低雲阻擋因子改用「沿太陽方位角、往日落/日出方向延伸 300 km 的真實光路」上的低雲，取代單點近似——霞光是陽光從地平線下方斜射、穿過數百公里低空後打在雲底的結果。
2. **衛星驗證迴路**：每天事後用向日葵衛星真彩影像自動判定「有沒有燒」（burnIndex），與預測分數並存，累積資料後以邏輯迴歸校準權重——讓模型可被驗證、能變準。

## A. 光路取樣

### 新模組 `scripts/geo.mjs`（純函式，零依賴）

- `sunAzimuthAt(dateMs, lat, lon): number`——NOAA 太陽位置演算法，回傳 0–360°（北=0 順時針）。測試錨點（容差 ±1.5°）：台北春秋分日落 ≈270°、夏至日落 ≈293°、冬至日落 ≈247°；日出鏡像（夏至 ≈67°、冬至 ≈113°）。
- `destinationPoint(lat, lon, bearingDeg, distanceKm): {lat, lon}`——球面大圓公式（地球半徑 6371 km）。測試錨點：台北向西（270°）300 km 後緯度略增/經度約 −2.98°；向北 111.2 km ≈ +1° 緯度。

### 取樣與加權（常數集中於 `update.mjs` 頂部）

- 光路取樣距離：`[40, 90, 150, 220, 300]` km，沿事件時刻太陽方位角方向。
- 光路權重：`[0.30, 0.25, 0.20, 0.15, 0.10]`（總和 1.0；越近觀測者光束越低、遮蔽效應越強）。
- 有效低雲 = `0.6 × 光路加權低雲 + 0.4 × 市中心低雲`，餵入既有 lowCloud 因子。**`score.mjs` 不改動。**
- 每場事件（next 兩場 + outlook 各場）各自算方位角與 5 個取樣點；日落與日出的取樣點不同、且逐日微變。

### 資料抓取

- Open-Meteo 多點 batch：`latitude=lat1,lat2,...&longitude=...`，回傳陣列。一次呼叫取全部光路點（sunset 5 點 + sunrise 5 點 = 10 點；outlook 各日方位角差 <2°，**共用 next 事件的取樣點**——300 km 尺度下誤差可忽略，避免點數爆炸），hourly 只要 `cloud_cover_low`，`forecast_days=5`。
- 市中心與空品呼叫維持原樣。總 HTTP 呼叫 2 → 3。batch 回應筆數與請求點數不符視為整次失敗（沿用大聲失敗原則）。

### 資料與前端

- `data.json` 每場事件加 `lightPath: { azimuth: 255, pathLow: 18, centerLow: 13, points: [{km: 40, low: 22}, ...] }`（數值皆四捨五入整數；azimuth 為整數度）。
- 前端「低雲阻擋」因子下加一行小字：`光路 (255°) 低雲 18%・市區 13%`。缺 `lightPath` 欄位時不顯示該行（向舊資料相容）。

## B. 衛星驗證迴路

### 影像來源（已實測可用）

NICT 向日葵真彩圖磚，URL 格式：
`https://himawari8.nict.go.jp/img/D531106/{Z}d/550/{YYYY}/{MM}/{DD}/{HHmmss}_{x}_{y}.png`
UTC 時間戳、10 分鐘一格、按時間戳永久封存。取「事件時刻 +10 分鐘」向下取整到 10 分鐘格的那一幀。zoom 與圖磚座標、台北像素窗（含周邊約 ±0.6° 的矩形）由實作時人工看圖校準一次後以常數寫死於 `verify.mjs`，附校準說明註解。

物理依據：地面日落後 10–20 分鐘，8 km 高空雲仍受陽光直射（此即火燒雲成因），從衛星真彩圖上呈受光暖色亮斑；無高雲或全低雲時該區域近黑。

### `scripts/verify.mjs`

CLI：`node scripts/verify.mjs sunset|sunrise`。流程：

1. 讀 `docs/history.json`，找**當天**（Asia/Taipei 日期）該場事件的最新一筆預測（比對 `sunsetTime`/`sunriseTime` 的日期部分）。找不到 → 非零碼結束（沒有預測就沒有可驗證對象）。
2. 算目標衛星時間戳（事件時刻 +10 分、UTC、向下取整 10 分鐘格），下載對應圖磚（重試 3 次，1s/4s/9s）。
3. 以 `pngjs` 解碼，取台北像素窗，計算：
   - `brightRatio`＝亮度 L>30（0–255 尺度）的像素比例
   - `warmRatio`＝(R > B+15 且 R>60) 的像素比例
   - `burnIndex = round(100 × min(1, warmRatio × 3))`——v1 相對指標，閾值待校準
4. Append `docs/verification.json`：`{ date, kind, eventTime, satTime, predictedScore, burnIndex, brightRatio, warmRatio, tileUrl }`。讀取容錯與寫入原則完全比照 `history.json`（只吞 ENOENT、壞檔大聲失敗、先讀後寫）。

### `verify.yml` workflow

| cron（UTC） | 台北 | 動作 |
|---|---|---|
| `0 12 * * *` | 20:00 | `verify sunset`（日落最晚 18:50，+10 分幀最晚 19:00，NICT 發布延遲 ~30 分內） |
| `0 0 * * *` | 08:00 | `verify sunrise`（日出最晚 06:40） |

步驟：checkout → setup-node 20 → `npm install --no-save pngjs@7` → 跑測試（明確檔案清單，含新測試檔）→ `node scripts/verify.mjs <kind>` → commit `docs/verification.json`（比照 update.yml 的 bot commit 寫法、`timeout-minutes: 10`、concurrency 共用 group `update-forecast` 避免與 update.yml 同時 push 撞車）。

### 依賴原則修訂

網站與預報管線（update.mjs/score.mjs/geo.mjs/index.html）維持零 npm 依賴；**verify 工具鏈允許 `pngjs`**（CI 以 `--no-save` 臨時安裝，repo 不進 package.json/node_modules）。本機跑 verify 測試前需自行 `npm install --no-save pngjs@7`。

### `scripts/calibrate.mjs`（手動工具，不進排程）

- 讀 `history.json` + `verification.json`，以 date+kind join。
- 配對 <40 筆：印出「資料不足（目前 N 筆）」後結束。
- ≥40 筆：以 `burnIndex ≥ 25` 為正標籤，對五因子分數（從歷史重算不可得，故 join `data.json` 快照不可行——**改為記錄時就把五因子分數存進 history**，見下）跑零依賴手寫邏輯迴歸（梯度下降，固定 5000 迭代、學習率 0.1、輸入標準化），輸出各因子係數與建議權重比例報告到 stdout。**不自動修改 `score.mjs`。**
- 連帶修改：`update.mjs` 的 history 紀錄加存 `sunriseFactors` / `sunsetFactors`（五因子 key→score 的物件），供日後校準使用。舊紀錄無此欄位者 calibrate 自動跳過。

### 前端

歷史表加「實況」欄：以 date+kind 比對 `verification.json`——🔥（burnIndex ≥50）｜「淡燒」（25–49）｜「—」（<25）｜空白（未驗證/無資料）。`verification.json` 載入失敗時整欄顯示空白，不影響其他區塊。頁尾演算法說明補一句驗證機制。

### C. 地面攝影機雙訊號（使用者指定新增）

衛星之外，加**事件時刻**的地面直播幀判定（更貼近肉眼觀感）：

- 日落：象山看台北 4K（YouTube `z_fY1pj1VBw`，台北觀光官方）；日出：烘爐地即時影像（`xxMRjVwCQ3o`，新北觀光官方）。
- 新 workflow `capture.yml`：cron `5 9 * * *`（台北 17:05，日落場，timeout 150 分）與 `30 20 * * *`（台北 04:30，日出場，timeout 160 分）。步驟：讀 `docs/data.json` 取事件時刻 → sleep 至事件 +8 分（已過 20 分以上則跳過離開）→ `pip install yt-dlp` + `yt-dlp -g` 取 HLS → `ffmpeg` 抓一幀縮到 320px 輸出 raw RGB → `node scripts/capture.mjs <kind>` 讀 raw bytes 對天空區域（上 45%）算 `camBurnIndex = round(100×min(1, camWarmRatio×2.5))`（暖像素：R>B+25 且 R>80）。
- `verification.json` 改為以 (date, kind) **upsert 合併**：capture 寫入 `camBurnIndex`/`camWarmRatio`，verify 寫入衛星欄位，兩班互不覆蓋對方欄位；concurrency 共用 group 序列化 push。
- 前端「實況」欄優先顯示 camBurnIndex，無則衛星 burnIndex。
- 直播斷線/yt-dlp 失敗：capture 以非零碼結束（Actions 標紅），衛星訊號不受影響。
- calibrate 的標籤改用 `camBurnIndex ?? burnIndex`。

## 錯誤處理總則

沿用初版：重試 3 次、任一環節失敗即非零碼結束且不寫檔、Actions 標紅寄信、舊資料不被半套覆蓋。verify 與 update 各自獨立失敗互不影響。

## 測試

- `geo.mjs`：方位角 5 個錨點、destinationPoint 2 個錨點、方位角連續性（相鄰兩日日落方位差 <1°）。
- `update.mjs` 新增：光路加權計算（權重和=1、加權數學）、batch 回應筆數不符拋錯、有效低雲混合公式、history 新欄位。
- `verify.mjs`：burnIndex 純計算函式（合成像素陣列：全黑→0、全暖亮→100、半暖→50）、時間戳取整、history 比對邏輯（找得到/找不到當天）。PNG 解碼與網路部分以一次手動真跑驗證。
- `calibrate.mjs`：合成資料（已知權重生成）→ 迴歸能還原正負號與大小順序；資料不足路徑。
- CI 測試指令同步加入新測試檔（明確清單）。

## 非目標（YAGNI）

- 不做自動改權重（calibrate 只出報告）。
- 不做人工回報。
- 不做 burnIndex 的歷史回填（從上線日開始累積）。
- 不做預測 vs 實況的統計圖表（資料夠了再說）。
