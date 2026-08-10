# 多地點擴充 設計文件

日期：2026-08-10
狀態：已與使用者確認之設計
前置：`2026-08-05-taipei-burning-sky-design.md`（初版）、`2026-08-06-lightpath-verification-design.md`（光路與驗證）

## 目的

把單點網站擴充為四個地點。原初版 spec 將「多城市支援」列為非目標，本文件明確推翻該決定。

| id | 名稱 | 緯度 | 經度 | 場次 | 驗證鏡頭（YouTube id） |
|---|---|---|---|---|---|
| `taipei` | 台北市中心 | 25.0400 | 121.5600 | 日落・日出 | 象山看台北 `z_fY1pj1VBw`／烘爐地 `xxMRjVwCQ3o` |
| `tamsui` | 淡水漁人碼頭 | 25.1830 | 121.4103 | 日落 | 淡水漁人碼頭 `xwAWSh35uuw`（新北旅客） |
| `gaomei` | 高美濕地 | 24.3128 | 120.5487 | 日落 | 高美濕地 4K `fjhg3gAnMFg`（台中觀光） |
| `wanggaoliao` | 望高寮 | 24.1339 | 120.6194 | 日出 | 望高寮 4K `lhXXhDyjFtI`（台中觀光） |

座標經 Open-Meteo 驗證：海拔分別為 10m／0m／0m／44m，與實地相符（淡水與高美濱海、望高寮丘陵）。
2026-08-10 實測日落 18:33–18:35、日出 05:25–05:30，四地時刻差在 5 分鐘內。

**每個地點只計算它宣告的場次。** 高美濕地是西向夕陽點，替它產生日出分數只是噪音。

## 架構原則

`score.mjs` 與 `geo.mjs` **完全不改動**——它們是純函式，不需要知道地點的存在。
多地點的複雜度全部收在 `locations.mjs`（設定）與 `update.mjs`（批次組裝）兩處。

## A. 地點設定 `scripts/locations.mjs`

單一事實來源，其餘模組一律從此讀取，不得各自硬編座標或鏡頭 id。

```js
export const LOCATIONS = [
  { id: 'taipei', name: '台北市中心', lat: 25.04, lon: 121.56,
    events: {
      sunset:  { camera: 'z_fY1pj1VBw', cameraName: '象山看台北' },
      sunrise: { camera: 'xxMRjVwCQ3o', cameraName: '烘爐地' },
    } },
  // …其餘三地同結構
];

export const DEFAULT_LOCATION = 'taipei';
export function locationById(id)          // 找不到則 throw
export function locationsWithEvent(kind)  // 回傳支援該場次的地點陣列，順序同 LOCATIONS
```

## B. 資料抓取與組裝（`update.mjs`）

### API 呼叫維持 3 次

Open-Meteo 支援逗號分隔多點批次，實測 40 點單次呼叫成功。因此地點數增加不會增加呼叫數：

| 批次 | 點數 | 內容 |
|---|---|---|
| 天氣 | 4（每地一點） | 分層雲量、濕度、能見度、降雨機率、日出日落 |
| 空品 | 4 | AOD |
| 光路 | 25 | 台北 2 場×5 + 其餘 3 地各 1 場×5 |

光路點數 = `locations.flatMap(loc => Object.keys(loc.events)).length × 5`。

### 批次索引對位（本次最高風險處）

三個批次回應都是陣列，順序即請求順序。錯位不會拋錯，只會安靜地把某地的天氣算成另一地的分數。

防護措施：
1. 組請求時同步建立索引對照表（`{locationId, kind} → 陣列位置`），不靠隱含順序推算。
2. 回應筆數與請求點數不符即整次失敗（沿用既有 `parsePathBatch` 的作法，天氣與空品批次比照辦理）。
3. 測試以「每個地點餵明顯不同的假資料」驗證分數確實跟著對應地點走（見測試節）。

### `data.json` 結構

```json
{
  "generatedAt": "2026-08-10T07:00:00.000Z",
  "trigger": "sunset-run",
  "locations": [
    {
      "id": "taipei",
      "name": "台北市中心",
      "events": {
        "sunset":  { "eventTime": "…+08:00", "score": 62, "level": "值得一看",
                     "factors": [ … ], "lightPath": { … } },
        "sunrise": { "…": "同結構" }
      },
      "outlook": [ { "date": "2026-08-11", "sunset": { "time": "…", "score": 55 } } ]
    }
  ]
}
```

`outlook` 只列該地點宣告的場次。頂層不再有 `next` 欄位——這是破壞性變更，但前端與資料同時部署，不需要相容層。

## C. 實況拍攝

### 參數變更

- `capture.mjs <kind> <frame.raw> <w> <h> [date] [thumb] [locationId]`——`locationId` 預設 `taipei`
- `capture-local.sh <kind> [date] [locationId]`
- 鏡頭 id 與名稱一律從 `locations.mjs` 查，不再寫死於 `capture.mjs` 的 `CAMERAS`（該常數移除）

### 縮圖路徑

`frames/<date>-<location>-<kind>.jpg`。既有兩張舊命名檔案（`2026-08-09-sunset.jpg`、
`2026-08-10-sunrise.jpg`）保持原檔名不動——紀錄裡存的是完整相對路徑，不受命名規則改變影響。

### 排程（`capture-scheduled.ps1`）

工作排程器維持兩個工作、時間不變（16:45／04:50）。腳本改為：

1. 讀 `data.json`，取出該場次所有地點的事件時刻
2. 依事件時刻由早到晚排序
3. 逐一：睡到「該地事件時刻 +8 分」→ 抓幀 → 計算
4. 全部完成後一次 commit＋push

單一地點失敗（鏡頭掛掉、錯過窗口逾 30 分）記 log 後**繼續處理下一個**，不中斷整批。
全部失敗才以非零碼結束。

日落場窗口約 10 分鐘（18:41→18:43），日出場約 13 分鐘（05:33→05:38）。

## D. 驗證資料

`verification.json` 每筆新增 `location` 欄位，主鍵由 (date, kind) 改為 **(date, kind, location)**。
`upsertVerification` 的比對條件同步改為三鍵。

**既有 8 筆紀錄**沒有 `location`，一次性補上 `"location": "taipei"`（該欄位缺漏時視為 `taipei`，
讀取端亦保留此預設，避免手動編輯遺漏造成靜默錯配）。

## E. 前端

頂部一排地點按鈕（pill 樣式），選擇存 `localStorage`，預設台北。切換後主卡、副卡、因子拆解、
趨勢、歷史表全部切換至該地點。只宣告一個場次的地點不顯示副卡。

歷史表只列該地點的紀錄。「實況」欄比對 (date, kind, location) 三鍵。

無 JS 或資料載入失敗時的行為與現況一致（顯示錯誤與重試鈕）。

## F. 權重校準

四地點樣本**合併**擬合。物理模型相同，合併可讓 40 筆門檻更快達到（每日 5 場，約八天）。
每筆樣本記錄 `location`，日後要分地點分析隨時可切。`calibrate.mjs` 的報告加一行各地點樣本數。

## 測試

- **`locations.mjs`**：id 不重複；座標落在台灣範圍（lat 21.5–25.5、lon 119.5–122.5）；
  每地至少一個場次；鏡頭 id 為 11 字元；`locationsWithEvent` 回傳順序與 `LOCATIONS` 一致；
  `locationById` 找不到時拋錯。
- **批次對位（重點）**：四地點各餵明顯不同的雲量／濕度，驗證每地分數對應到自己的資料；
  刻意打亂或截短回應陣列必須拋錯而非產生錯分數。
- **`buildData` 多地點**：只產生宣告的場次；`outlook` 對應正確；`lightPath` 綁對地點。
- **`verification.mjs`**：三鍵 upsert（同日同場次不同地點視為不同筆）；無 `location` 的舊紀錄
  視為 `taipei`。
- **`capture.mjs`**：`framePathFor` 含地點；鏡頭資訊取自 `locations.mjs`；未知地點拋錯。
- **`calibrate.mjs`**：合併樣本含地點欄位；報告列出各地點筆數。
- CI 測試檔清單同步加入 `locations.test.mjs`。

## 已知限制（誠實記錄）

- **電腦沒開的代價變大**：以前漏一場，現在日落一次漏三場。既有限制的放大，非新問題。
- **新鏡頭穩定性未知**：烘爐地一週內出過兩次狀況（待機卡、偵測誤判各一）。新增三支沒有觀察
  資料，頭幾天可能出現待機卡而被標記排除。兩道防線都已就位。
- **望高寮的場次依使用者指定為日出**。該地實際上也是知名夜景與夕陽點，日後若要加日落場，
  在 `locations.mjs` 補一個 `sunset` 條目即可，其餘程式不需改動。

## 非目標（YAGNI）

- 不做使用者自訂地點。
- 不做地點間的比較排行（先做切換器；若日後確有需要再加）。
- 不做各地點獨立的權重（先合併擬合，資料足夠再談分化）。
- 不改 `score.mjs` 的權重與曲線——那要等校準結果，與本次擴充無關。
