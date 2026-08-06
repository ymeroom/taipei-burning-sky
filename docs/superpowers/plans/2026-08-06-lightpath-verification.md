# 光路取樣 + 衛星驗證迴路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（本計畫為 inline 執行自用版：介面、常數、測試錨點完整且不可偏離；程式碼主體依 spec 於執行時落地）。Steps use checkbox (`- [ ]`) syntax.

**Goal:** 低雲因子改用真實光路取樣，並建立向日葵衛星每日自動驗證迴路與權重校準工具。

**Architecture:** 新增純函式模組 geo.mjs（太陽方位角＋大圓取點）；update.mjs 增加 Open-Meteo 多點 batch 與有效低雲混合；新 verify.mjs＋verify.yml 每日兩班抓 NICT 圖磚算 burnIndex 寫 verification.json；calibrate.mjs 為手動邏輯迴歸工具。

**Tech Stack:** Node 20+、node --test、GitHub Actions；pngjs 僅限 verify 工具鏈（CI `--no-save`）。

**Spec:** `docs/superpowers/specs/2026-08-06-lightpath-verification-design.md`（本計畫的細節依據，衝突時以 spec 為準）

## Global Constraints

- 網站與預報管線零 npm 依賴；pngjs 僅限 verify 工具鏈（CI `npm install --no-save pngjs@7`）
- `score.mjs` 不改動
- 測試：repo 根 `node --test`（本機）；CI 用明確檔案清單並加入新測試檔
- 大聲失敗原則沿用（重試 3 次 1s/4s/9s、失敗不寫檔、只吞 ENOENT）
- 繁中、commit 尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 常數：光路距離 `[40,90,150,220,300]` km、權重 `[0.30,0.25,0.20,0.15,0.10]`、有效低雲 `0.6*path + 0.4*center`、burnIndex `= round(100*min(1, warmRatio*3))`、亮像素 L>30、暖像素 R>B+15 且 R>60

---

### Task 1: `scripts/geo.mjs`（TDD）

**Files:** Create `scripts/geo.mjs`、`scripts/geo.test.mjs`

**Interfaces (Produces):**
- `sunAzimuthAt(dateMs: number, lat: number, lon: number): number`（0–360，北=0 順時針；NOAA 演算法）
- `destinationPoint(lat, lon, bearingDeg, distanceKm): {lat, lon}`（R=6371）

**測試錨點（容差 ±1.5°／±0.03°）：**
- 台北 (25.04, 121.56)：2026-03-20 日落 18:11 → az ≈ 271；2026-06-21 日落 18:47 → az ≈ 293；2025-12-21 日落 17:07 → az ≈ 245；2026-06-21 日出 05:05 → az ≈ 66；2025-12-21 日出 06:34 → az ≈ 115（錨點值以 NOAA 網頁計算器口徑；實作後若系統性偏移 >1.5° 則檢查公式而非放寬容差）
- `destinationPoint(25.04,121.56,270,300)` → lon ≈ 118.585、lat ≈ 25.04±0.15；`(25.04,121.56,0,111.195)` → lat ≈ 26.04
- 連續性：2026-08-06 與 08-07 日落方位角差 < 1°

- [ ] 寫失敗測試 → 紅
- [ ] 實作 NOAA 太陽位置（fractional year → eqtime/decl → hour angle → azimuth）與大圓公式
- [ ] 全綠（46+新）
- [ ] Commit `feat: 太陽方位角與大圓取點純函式`

### Task 2: update.mjs 光路整合（TDD）

**Files:** Modify `scripts/update.mjs`、`scripts/update.test.mjs`

**Interfaces:**
- Consumes: Task 1 兩函式
- Produces（供 Task 5 前端）: `data.next.*.lightPath = {azimuth:int, pathLow:int, centerLow:int, points:[{km:int, low:int}]}`；history 紀錄加 `sunriseFactors`/`sunsetFactors`（`{canvas,lowCloud,clarity,aerosol,rain}` → score int）
- 內部: `buildLightPath(kind, eventIso)` → 取樣點列；`fetchPathBatch(points)` → batch 呼叫（hourly=cloud_cover_low, forecast_days=5）；`effectiveLow = 0.6*Σ(w_i*low_i) + 0.4*centerLow`
- outlook 共用 next 事件取樣點（spec 裁定）；`buildData` 簽名擴充為吃 pathSamples

**測試（新增）：**
- 權重總和恰為 1.0（常數自檢）
- 光路加權數學：低雲 [10,20,30,40,50] × 權重 [0.30,0.25,0.20,0.15,0.10] → 25；effectiveLow(25, 13) = 0.6×25 + 0.4×13 = 20.2
- batch 回應筆數 ≠ 請求點數 → 拋錯
- buildData 產出含 lightPath 欄位且皆為整數；history 新欄位存在且與 factors 對應
- 既有 22 條 update 測試全部保持綠（fixture 需補 batch 假資料）

- [ ] 紅 → 實作 → 綠 → 手動真跑 `node scripts/update.mjs manual` 檢查 data.json 的 lightPath 合理（8 月日落 az≈285±8、日出 az≈75±8）
- [ ] Commit `feat: 低雲因子改用真實光路取樣`

### Task 3: `scripts/verify.mjs`（TDD + 一次人工校準）

**Files:** Create `scripts/verify.mjs`、`scripts/verify.test.mjs`

**Interfaces:**
- CLI `node scripts/verify.mjs sunset|sunrise`
- Produces: `docs/verification.json` append `{date, kind, eventTime, satTime, predictedScore, burnIndex, brightRatio, warmRatio, tileUrl}`
- 純函式 exports（測試標的）：`satTimestampFor(eventIso)`（+10 分、UTC、floor 10 分格 → `{path:'YYYY/MM/DD/HHmmss', iso}`）、`burnMetrics(rgbaBuf, width, height, window)` → `{brightRatio, warmRatio, burnIndex}`、`findTodayPrediction(history, kind, taipeiDate)` → 紀錄或 null
- pngjs 以動態 `await import('pngjs')` 載入（僅 main 路徑），純函式測試不需 pngjs

**測試：** 合成像素（全黑→burnIndex 0；全暖亮 R200/B50→100；半暖→50）；satTimestampFor(`2026-08-06T18:35`) → `2026/08/06/104000`；findTodayPrediction 找得到/找不到兩路徑；壞 verification.json 大聲失敗（比照 readHistory 模式）

**人工校準步驟（一次性）：** 抓白天幀（如 03:30 UTC）zoom 8d 數個候選圖磚 → 我看圖確認台灣位置 → 定圖磚 (x,y) 與台北像素窗常數，寫死並附註解（含校準日期與依據幀 URL）

- [ ] 紅 → 實作 → 綠 → `npm install --no-save pngjs@7` 後手動真跑 `node scripts/verify.mjs sunset`（驗今天 18:35 場，若尚未到時刻改抓昨日：CLI 加第二參數 date override，僅手測用）確認 verification.json 合理
- [ ] Commit `feat: 向日葵衛星 burnIndex 驗證腳本`

### Task 4: `verify.yml` + `calibrate.mjs` + CI 清單

**Files:** Create `.github/workflows/verify.yml`、`scripts/calibrate.mjs`、`scripts/calibrate.test.mjs`；Modify `.github/workflows/update.yml`（測試清單加 geo/verify/calibrate 測試檔）

**verify.yml：** cron `0 12 * * *`（sunset）與 `0 0 * * *`（sunrise）、workflow_dispatch（帶 kind input，預設 sunset）、permissions contents: write、concurrency group `update-forecast`、timeout-minutes 10、steps：checkout → node 20 → `npm install --no-save pngjs@7` → 測試（明確清單）→ `node scripts/verify.mjs <kind>`（schedule 三元判斷同 update.yml 模式）→ commit `docs/verification.json`

**calibrate.mjs：** join history×verification（date+kind、需 factors 欄位）；<40 筆印 `資料不足（目前 N 筆）` exit 0；≥40 筆：標籤 burnIndex≥25、五因子分數標準化、手寫邏輯迴歸（5000 迭代、lr 0.1）、輸出係數與建議權重比例。**不改 score.mjs。**

**測試：** 合成 60 筆（真權重 [2,1.5,0.5,0.3,0.2] 生成標籤）→ 迴歸係數正負號全對且 canvas 係數最大；資料不足路徑；join 跳過無 factors 的舊紀錄

- [ ] 紅 → 實作 → 綠
- [ ] Commit `feat: 衛星驗證排程與權重校準工具`

### Task 5: 前端 + 部署 + 端對端

**Files:** Modify `docs/index.html`

- 低雲阻擋因子下加小字 `光路 (N°) 低雲 X%・市區 Y%`（無 lightPath 欄位不顯示）
- 歷史表加「實況」欄：verification.json 以 date+kind 比對 → 🔥 ≥50｜淡燒 25–49｜— <25｜空白未驗證；fetch 失敗整欄空白不影響其他區塊
- 頁尾演算法說明補光路與驗證機制各一句

- [ ] 本機 `npx -y http-server docs -p 8877` + browser-cli 驗證（含手機寬度、無 verification.json 的容錯）
- [ ] Commit `feat: 前端顯示光路明細與衛星實況欄`
- [ ] Push main → `gh workflow run update.yml` 確認綠 + data.json 含 lightPath → `gh workflow run verify.yml -f kind=sunset`（若當天日落已過）確認 verification.json 生成 → 線上頁面 browser 驗證 → `git pull --rebase`
