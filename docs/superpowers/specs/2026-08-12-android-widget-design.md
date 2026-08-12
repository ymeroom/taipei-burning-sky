# Android Widget 與通知 設計文件

日期：2026-08-12
狀態：已與使用者確認之設計
前置：`2026-08-10-multi-location-design.md`（四地點資料格式）

## 目的

在 Android 手機桌面顯示最新火燒雲預測，並在值得出門時主動發通知。

## 關鍵決定：不需要推播伺服器

`data.json` 已是 GitHub Pages 上的公開靜態檔。App 直接輪詢即可，**不需要 Firebase、金鑰或任何後端**。
所謂「推播」以本機通知（`NotificationCompat`）實現——由 App 自己判斷條件後發出，不經過推播服務。
這讓整個功能維持與專案一致的零成本、零維護特性。

```
GitHub Pages data.json
        │ WorkManager 週期工作（1 小時，需網路）
        ▼
    解析 → 存進 SharedPreferences
        │                    │
        ▼                    ▼
   更新桌面 widget      判斷是否發通知
```

## 技術選擇

| 項目 | 選擇 | 理由 |
|---|---|---|
| 語言 | Kotlin | Android 標準 |
| Widget | 傳統 `RemoteViews` + `AppWidgetProvider` | 只有文字與數字。改用 Glance／Compose 會把 APK 從約 2MB 撐到 8MB 以上並拉進大量相依 |
| 排程 | `androidx.work:work-runtime-ktx` | 系統級週期工作，重開機後仍存活，自帶退避重試 |
| 網路 | `HttpURLConnection`（JDK 內建） | 單一 GET 幾 KB，不值得引入 OkHttp／Retrofit |
| JSON | `org.json`（Android 內建） | 同上，不引入 Gson／Moshi |
| 相依總計 | `androidx.core-ktx`、`androidx.work` | 僅此兩項 |

`minSdk 26`（Android 8）、`targetSdk 34`、`compileSdk 34`。

## 輪詢策略

**每小時一次**，非固定時刻。理由：GitHub Actions cron 實測會延遲 1–2.5 小時
（見 `2026-08-05` spec 與 README 的漏拍紀錄），因此「15:05 去抓」反而常抓到舊資料。
每小時輪詢是幾 KB 的純文字請求，電池影響不可感知，且預報一更新即跟上。

WorkManager 週期工作最短間隔為 15 分鐘；本設計用 1 小時並加上 `NetworkType.CONNECTED` 限制。
Doze 模式下可能延後執行，屬可接受（預報本來就一天只更新兩次）。

## Widget（4×2）

```
下一場・日落  18:32   還有 2 小時 15 分
高美 76    台北 40    淡水 34
                           更新於 15:04
```

- 只列該場次**有資料的地點**：日落場三個（台北、淡水、高美）、日出場兩個（台北、望高寮）
- 最高分者以霞光橘（`#f0805a`）加亮，其餘用次要色
- `generatedAt` 距今超過 **16 小時**時，右下改顯示「⚠ 資料過期」（與網站同一判準）
- 點擊開啟 `https://ymeroom.github.io/taipei-burning-sky/`
- 深色底、圓角，與網站視覺一致

「下一場」的判定沿用網站邏輯：取所有地點所有場次中**時間最近且尚未過去**者的場次類型；
若全部已過去（資料嚴重過期）則維持時間順序，交由過期警示處理。

## 通知

**觸發條件（三者皆須成立）**：
1. 該場次任一地點分數 **≥ 50**（值得一看）
2. 該場事件**尚未通知過**——以 `<事件日期>:<場次>` 為鍵記在 SharedPreferences
3. 事件時刻尚未過去

第 2 點是必要的：每小時輪詢一次，沒有去重會對同一場事件重複轟炸，使用者很快就會關掉通知。

**內容**：

> **今晚可能會燒**
> 高美濕地 76 分・大燒預警
> 日落 18:35，還有 3 小時

日出場標題改為「明早可能會燒」。點擊開啟網站。
通知頻道 `burning-sky-alert`，重要性 `IMPORTANCE_DEFAULT`（會出現在通知列但不強制打斷）。

Android 13+ 需要 `POST_NOTIFICATIONS` 執行階段權限——App 首次開啟時請求；
使用者拒絕時 widget 仍正常運作，只是不發通知。

## 錯誤處理

- 抓取失敗：沿用 SharedPreferences 裡的上次資料，widget 照常顯示並標示可能過期，**絕不顯示空白**。
  WorkManager 回傳 `Result.retry()` 走內建退避。
- JSON 格式非預期（例如日後又改結構）：不寫入偏好設定，保留舊資料，記 log。
  沿用專案「大聲失敗、不用壞資料覆蓋好資料」的原則。
- 無網路：WorkManager 的 `NetworkType.CONNECTED` 限制會延後執行，不算失敗。

## App 主畫面

極簡單一頁：顯示目前四地點分數、一個「立即更新」按鈕、通知權限狀態與開關說明。
主要用途是首次啟動時請求通知權限，以及讓使用者確認 App 有在運作。
**不重複實作網站已有的因子拆解與歷史**——那些點 widget 或通知就會開網站。

## 專案位置與建置

`android/` 子資料夾，與資料格式同 repo，避免日後改 `data.json` 結構時忘記同步消費端。
`.gitignore` 加入 `android/build/`、`android/.gradle/`、`android/app/build/`、`android/local.properties`。

- JDK：Android Studio 內建 JBR 21（`C:\Program Files\Android\Android Studio\jbr`）
- SDK：`C:\Users\ymero\AppData\Local\Android\Sdk`（已有 android-34、build-tools 37.0.0、platform-tools）
- 建置：`gradlew assembleDebug` → `android/app/build/outputs/apk/debug/app-debug.apk`
- 簽章：debug keystore（`~/.android/debug.keystore`）。此機器上固定不變，更新可直接覆蓋安裝。
  非上架用途，不需要 release 簽章流程。

**現有 Node 專案完全不受影響**：CI 的測試清單是明確檔名列表，不會掃到 Android 專案。

## 安裝與驗證

使用者手機開啟開發者模式並以 USB 連接，以 `adb install -r` 安裝，實機驗證：
widget 版面、深色底可讀性、通知外觀、點擊開啟網站、過期狀態顯示。

## 測試

**可在電腦上跑（JUnit，無需裝置）**——這些都是純函式：

- `parseForecast(json)`：解析多地點結構；缺欄位、空 locations、格式錯誤各自的行為
- `nextEvent(forecast, now)`：挑下一場；日落前／日落後／全部過去三種情境
- `scoresForEvent(forecast, kind)`：只回傳該場次有資料的地點，依分數排序
- `shouldNotify(forecast, kind, lastNotifiedKey, now)`：門檻、去重、事件已過去三條規則
- `isStale(generatedAt, now)`：16 小時判準邊界

**需要實機**：widget 渲染、通知外觀、WorkManager 實際排程、點擊開啟網站。

## 已知限制（誠實記錄）

- **預測模型尚未校準。** 目前只有 8 筆有效樣本（門檻 40 筆），權重是憑物理常識設的。
  通知會依這個未驗證的分數發出，可能誤報或漏報。校準完成後 App 不需改動，分數自然變準。
- Doze 模式可能讓輪詢延後，最壞情況下通知會比預報晚一兩小時。對「今晚要不要出門」仍足夠。
- 部分廠商（小米、OPPO 等）的省電機制會更積極地終止背景工作，可能需要手動把 App 加入白名單。

## 非目標（YAGNI）

- 不做推播伺服器與 Firebase。
- 不做 iOS。
- 不做 App 內的因子拆解與歷史紀錄——網站已經有，點開就好。
- 不做多 widget 尺寸與設定畫面（先做單一 4×2；不夠再說）。
- 不上架 Google Play。
