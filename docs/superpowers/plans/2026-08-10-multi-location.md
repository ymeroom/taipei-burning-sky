# 多地點擴充 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（inline 執行自用版：介面、常數、測試錨點完整且不可偏離；程式碼主體依 spec 於執行時落地）。Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把單點預報擴充為四地點（台北、淡水漁人碼頭、高美濕地、望高寮），各自具備預報與鏡頭實況驗證。

**Architecture:** 新增 `locations.mjs` 作為地點設定的單一事實來源；`update.mjs` 改用 Open-Meteo 多點批次（API 呼叫數維持 3 次）並以顯式索引對照表避免錯位；`score.mjs` 與 `geo.mjs` 完全不動。

**Tech Stack:** Node 20+、node --test、零 npm 依賴、GitHub Actions、Windows 工作排程器。

**Spec:** `docs/superpowers/specs/2026-08-10-multi-location-design.md`（衝突時以 spec 為準）

## Global Constraints

- 零 npm 依賴；`score.mjs` 與 `geo.mjs` 不得改動
- 測試：本機 repo 根 `node --test`；CI 用明確檔案清單（須加入 `locations.test.mjs`）
- 座標與鏡頭 id 一律從 `locations.mjs` 讀，禁止在其他檔案硬編
- 大聲失敗沿用：重試 3 次（1s/4s/9s）、批次筆數不符即整次失敗、失敗不寫檔、只吞 ENOENT
- 繁中；commit 尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 四地點：`taipei` 25.04/121.56（sunset+sunrise）、`tamsui` 25.1830/121.4103（sunset）、`gaomei` 24.3128/120.5487（sunset）、`wanggaoliao` 24.1339/120.6194（sunrise）
- 鏡頭 id：象山 `z_fY1pj1VBw`、烘爐地 `xxMRjVwCQ3o`、淡水 `xwAWSh35uuw`、高美 `fjhg3gAnMFg`、望高寮 `lhXXhDyjFtI`

---

### Task 1: `scripts/locations.mjs`（TDD）

**Files:** Create `scripts/locations.mjs`、`scripts/locations.test.mjs`

**Interfaces (Produces):**
- `LOCATIONS`：陣列，每筆 `{ id, name, lat, lon, events: { sunset?: {camera, cameraName}, sunrise?: {...} } }`
- `DEFAULT_LOCATION = 'taipei'`
- `locationById(id)` → 地點物件；找不到 throw `locationById: 未知地點 <id>`
- `locationsWithEvent(kind)` → 支援該場次的地點陣列，順序同 `LOCATIONS`

**測試錨點：**
- id 不重複；共 4 筆；`DEFAULT_LOCATION` 存在於 LOCATIONS
- 座標落在台灣範圍：lat 21.5–25.5、lon 119.5–122.5
- 每地至少一個場次；場次鍵只能是 `sunset`/`sunrise`
- 每個鏡頭 id 符合 `/^[\w-]{11}$/`；`cameraName` 非空；鏡頭 id 全域不重複
- `locationsWithEvent('sunset')` → `['taipei','tamsui','gaomei']`（順序）
- `locationsWithEvent('sunrise')` → `['taipei','wanggaoliao']`
- `locationById('gaomei').lat === 24.3128`；`locationById('nope')` throws

- [ ] 寫失敗測試 → 紅 → 實作 → 綠 → Commit `feat: 地點設定模組`

### Task 2: update.mjs 多地點批次（TDD，本次最高風險）

**Files:** Modify `scripts/update.mjs`、`scripts/update.test.mjs`

**Interfaces:**
- Consumes: Task 1 全部；既有 `scoreEvent`/`interpolate`/`sunAzimuthAt`/`destinationPoint`
- Produces（供 Task 3/4/5）：
  - `buildRequestPlan()` → `{ weatherPoints: [{lat,lon}], airPoints: [...], pathPoints: [...], pathIndex: Map<'<locId>:<kind>', number> }`
    （`pathIndex` 值為該地該場次五個光路點在 `pathPoints` 中的**起始索引**）
  - `parseBatch(payload, expectedCount, label)` → 陣列（取代 `parsePathBatch`，`label` 進錯誤訊息）
  - `buildData(weather, air, paths, trigger, now)` → 新結構（見下）
- 移除：`LAT`/`LON` 常數、單點 URL 常數

**`data.json` 新結構：**
```
{ generatedAt, trigger, locations: [
  { id, name, events: { sunset?: {eventTime, score, level, factors, lightPath}, sunrise?: {...} },
    outlook: [ { date, sunset?: {time,score}, sunrise?: {time,score} } ] } ] }
```
頂層不再有 `next`。

**history.json 的寫入端也在本任務**（讀取端在 Task 3）：`main()` append 的紀錄改為
`{ ranAt, trigger, locations: { <id>: { sunsetScore?, sunsetTime?, sunsetFactors?, sunriseScore?, sunriseTime?, sunriseFactors? } } }`，
只寫該地宣告的場次。

**測試錨點（對位是重點）：**
- `buildRequestPlan()`：weatherPoints 4 筆、airPoints 4 筆、pathPoints 25 筆；
  `pathIndex.get('taipei:sunset')===0`、`taipei:sunrise`===5、`tamsui:sunset`===10、`gaomei:sunset`===15、`wanggaoliao:sunrise`===20
- **錯位防護**：四地點各餵明顯不同的中高雲量（台北 40、淡水 0、高美 100、望高寮 40），
  驗證 `taipei` canvas 得分高、`tamsui` 與 `gaomei` canvas 為 0——分數必須跟著自己的地點走
- `parseBatch` 筆數不符拋錯且訊息含 label；單點物件回應自動包成陣列
- `buildData`：`gaomei` 只有 `sunset` 鍵、無 `sunrise`；`wanggaoliao` 只有 `sunrise`；`taipei` 兩者皆有
- `outlook` 每筆只含該地宣告的場次；長度 3
- 既有 61 條 update 測試須全部改寫為新結構後仍綠

- [ ] 紅 → 實作 → 綠 → 真跑 `node scripts/update.mjs manual`，人工檢查四地點分數與光路方位角合理（八月日落約 289°、日出約 71°）→ Commit `feat: 四地點批次預報`

### Task 3: 驗證資料三鍵（TDD）

**Files:** Modify `scripts/verification.mjs`、`scripts/capture.mjs`、`scripts/capture.test.mjs`、`docs/verification.json`

**Interfaces:**
- `upsertVerification(records, rec)`：比對改為 (date, kind, location)，缺 `location` 視為 `'taipei'`
- `findTodayPrediction(history, kind, taipeiDate)` 不變（history 仍為全域預測，非分地點）
  → **注意**：history 目前只存台北分數。多地點後 history 需改存各地分數，見下。
- `capture.mjs`：移除 `CAMERAS`，改 `locationById(locId).events[kind]`；
  `framePathFor(date, location, kind)` → `frames/<date>-<location>-<kind>.jpg`
- CLI：`node scripts/capture.mjs <kind> <frame.raw> <w> <h> [date] [thumb] [locationId=taipei]`

**history.json 連帶變更（`update.mjs`）：** 每次執行 append 一筆
`{ ranAt, trigger, locations: { <id>: { sunsetScore?, sunsetTime?, sunsetFactors?, sunriseScore?, ... } } }`。
`findTodayPrediction(history, kind, date, locationId)` 新增第四參數，於 `locations[locationId]` 下查找；
舊格式紀錄（欄位在頂層）視為 `taipei` 以維持既有 8 筆可用。

**測試錨點：**
- 同日同場次不同地點視為兩筆；同三鍵則合併
- 無 `location` 的舊紀錄與 `location:'taipei'` 視為同一筆
- `framePathFor('2026-08-11','gaomei','sunset')` → `frames/2026-08-11-gaomei-sunset.jpg`
- `findTodayPrediction` 新舊 history 格式皆可查；未知地點回 null
- `capture.mjs` 未知 locationId 拋錯

**資料遷移：** `docs/verification.json` 既有 8 筆補上 `"location": "taipei"`（人工編輯，不寫遷移腳本）

- [ ] 紅 → 實作 → 綠 → Commit `feat: 驗證資料支援多地點`

### Task 4: 拍攝腳本與排程

**Files:** Modify `scripts/capture-local.sh`、`scripts/capture-scheduled.ps1`

- `capture-local.sh <kind> [date] [locationId]`：鏡頭 id 從 `locations.mjs` 查（`node --input-type=module` 取得），
  其餘管線不變（雙幀 + 縮圖）
- `capture-scheduled.ps1`：讀 `data.json`，取 `locations[].events[kind].eventTime` 組成清單、
  依時刻排序，逐一睡到「該地事件 +8 分」後呼叫 `capture-local.sh` 帶地點。
  單一地點失敗（錯過窗口逾 30 分、抓幀失敗）記 log 後**繼續下一個**；全數失敗才非零碼結束。
  最後一次 `git add docs/verification.json docs/frames` 後 commit＋push。
- `.ps1` 存檔維持 UTF-8 with BOM

**驗證：** `powershell -File scripts\capture-scheduled.ps1 -Kind sunset -Now` 實跑一次，
確認三支鏡頭依序抓完、三張縮圖產出、verification.json 三筆、log 中文正常。驗完把測試紀錄與縮圖還原。

- [ ] 實作 → 實跑驗證 → Commit `feat: 多地點拍攝排程`

### Task 5: 前端地點切換器

**Files:** Modify `docs/index.html`

- 頂部 pill 樣式地點按鈕列，選擇存 `localStorage.burningSkyLocation`，預設 `taipei`
- 切換後主卡／副卡／因子拆解／趨勢／歷史表全部換成該地點
- 只宣告一個場次的地點不顯示副卡
- 歷史表以 (date, kind, location) 三鍵比對「實況」欄；只列該地點紀錄
- 資料載入失敗行為不變

**驗證：** `npx http-server docs -p 8877` + browser-cli 檢查四地點切換、375px 手機版無橫向捲動、
localStorage 記憶生效、單場次地點無副卡。

- [ ] 實作 → 瀏覽器驗證 → Commit `feat: 前端地點切換器`

### Task 6: 校準支援多地點（TDD）

**Files:** Modify `scripts/calibrate.mjs`、`scripts/calibrate.test.mjs`

**Interfaces:**
- Consumes: Task 2 的新 history 格式、Task 3 的 `location` 欄位
- `joinSamples(history, verifications)`：改為以 (date, kind, location) 三鍵配對；
  樣本物件加 `location` 欄位；四地點**合併**擬合（物理模型相同）
- `countByLocation(samples)` → `{ taipei: 5, gaomei: 2, … }`
- `report(samples, suspectCount)` 加一行各地點樣本數

**測試錨點：**
- 同日同場次不同地點各自成為獨立樣本
- 舊格式 history（欄位在頂層、無 locations 鍵）仍能配對為 `taipei`
- 可疑與無訊號紀錄照樣排除（既有行為不得回歸）
- `countByLocation` 統計正確；`report` 輸出含「各地點樣本數」字樣
- 40 筆門檻邏輯不變

- [ ] 紅 → 實作 → 綠 → `node scripts/calibrate.mjs` 確認輸出合理 → Commit `feat: 校準支援多地點`

### Task 7: CI、文件、部署

**Files:** Modify `.github/workflows/update.yml`、`README.md`

- workflow 測試清單加入 `scripts/locations.test.mjs`（現有清單為 score／geo／update／capture／calibrate 五檔）
- README：地點表、多地點運作說明、`capture-local.sh` 新參數、四地點排程窗口
- 手動 dispatch `update.yml` 確認綠燈與 `tests` 數正確
- 線上以 browser-cli 驗證四地點切換

- [ ] 實作 → push → dispatch 驗證 → 線上驗證 → Commit `docs: 多地點說明`
