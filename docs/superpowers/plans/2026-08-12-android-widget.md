# Android Widget 與通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（inline 執行自用版：介面、常數、測試錨點完整且不可偏離）。Steps use checkbox (`- [ ]`) syntax.

**Goal:** Android 桌面 widget 顯示四地點最新火燒雲分數，並在任一地點 ≥50 分時發本機通知。

**Architecture:** WorkManager 每小時抓 GitHub Pages 的公開 `data.json` → 存 SharedPreferences → 更新 widget 並判斷是否通知。純函式邏輯（解析、挑場次、通知決策）與 Android 框架完全隔離，可在 JVM 上單測。

**Tech Stack:** Kotlin、AppWidgetProvider + RemoteViews、androidx.work、HttpURLConnection、org.json、JUnit4。

**Spec:** `docs/superpowers/specs/2026-08-12-android-widget-design.md`（衝突時以 spec 為準）

## Global Constraints

- 相依只有 `androidx.core:core-ktx` 與 `androidx.work:work-runtime-ktx`——不得引入 Compose／Glance／OkHttp／Retrofit／Gson／Moshi
- `minSdk 26`、`targetSdk 34`、`compileSdk 34`
- JDK：`C:\Program Files\Android\Android Studio\jbr`；SDK：`C:\Users\ymero\AppData\Local\Android\Sdk`
- 專案位於 `android/`；`.gitignore` 加 `android/build/`、`android/.gradle/`、`android/app/build/`、`android/local.properties`
- 資料來源：`https://ymeroom.github.io/taipei-burning-sky/data.json`
- 輪詢間隔 1 小時、限制 `NetworkType.CONNECTED`
- 通知門檻分數 **≥ 50**；去重鍵 `<事件日期>:<場次>`；通知頻道 id `burning-sky-alert`
- 過期門檻 **16 小時**
- 等級配色沿用網站：`>=75 #f0805a`／`>=50 #f0a05a`／`>=25 #8b94b2`／`<25 #6a7290`
- 使用者可見文字繁體中文
- 現有 Node 專案不得受影響（CI 測試清單為明確檔名，不會掃到 android/）
- Commit 訊息繁中、結尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Structure

```
android/
├── settings.gradle.kts、build.gradle.kts、gradle.properties、gradlew(.bat)
│   └── gradle/wrapper/gradle-wrapper.properties
└── app/
    ├── build.gradle.kts
    └── src/
        ├── main/
        │   ├── AndroidManifest.xml
        │   ├── java/com/ymeroom/burningsky/
        │   │   ├── Forecast.kt        # 資料類別 + 純函式（本次唯一有單測的檔案）
        │   │   ├── Repository.kt      # 抓取 + SharedPreferences 存取（薄，含 IO）
        │   │   ├── SyncWorker.kt      # WorkManager 工作：抓 → 存 → 更新 widget → 判斷通知
        │   │   ├── Notifier.kt        # 建立頻道與發送通知
        │   │   ├── BurningSkyWidget.kt# AppWidgetProvider：把資料畫進 RemoteViews
        │   │   └── MainActivity.kt    # 極簡主畫面 + 通知權限請求
        │   └── res/{layout,drawable,values,xml}/…
        └── test/java/com/ymeroom/burningsky/ForecastTest.kt
```

**分層原則**：`Forecast.kt` 不 import 任何 `android.*`，所有判斷邏輯都在這裡，因此能在 JVM 上跑真單測。
其餘檔案只做「呼叫純函式 + 操作框架」，薄到不需要 instrumentation test。

---

### Task 1: Gradle 骨架與空專案可建置

**Files:** Create `android/settings.gradle.kts`、`android/build.gradle.kts`、`android/gradle.properties`、
`android/gradle/wrapper/gradle-wrapper.properties`、`android/gradlew`、`android/gradlew.bat`、
`android/app/build.gradle.kts`、`android/app/src/main/AndroidManifest.xml`、
`android/local.properties`（不進版控）；Modify `.gitignore`

**Interfaces (Produces):** applicationId `com.ymeroom.burningsky`；可執行 `./gradlew assembleDebug`

- [ ] **Step 1:** 用本機**已快取**的 Gradle 8.2 產生 wrapper（不必上網下載 gradle 發行版）：
      ```bash
      GRADLE=/c/Users/ymero/.gradle/wrapper/dists/gradle-8.2-bin/bbg7u40eoinfdyxsxr3z4i7ta/gradle-8.2/bin/gradle
      cd android && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" "$GRADLE" wrapper --gradle-version 8.2
      ```
      產出 `gradlew`、`gradlew.bat`、`gradle/wrapper/gradle-wrapper.{jar,properties}`。
- [ ] **Step 2:** `app/build.gradle.kts` 設定 compileSdk 34／minSdk 26／targetSdk 34、
      `testImplementation("junit:junit:4.13.2")`、上述兩個 androidx 相依。
      **AGP 固定 8.1.4**——與本機快取的 Gradle 8.2 相容（AGP 8.5+ 需要 Gradle 8.7，會觸發額外下載）。
- [ ] **Step 3:** `local.properties` 寫入 `sdk.dir=C\:\\Users\\ymero\\AppData\\Local\\Android\\Sdk`；
      `.gitignore` 加入四條 Android 忽略規則
- [ ] **Step 4:** 最小 `AndroidManifest.xml`（含 `INTERNET`、`POST_NOTIFICATIONS` 權限）
- [ ] **Step 5:** 驗證 `JAVA_HOME="C:\Program Files\Android\Android Studio\jbr" ./gradlew assembleDebug` 成功產出 APK
- [ ] **Step 6:** Commit `feat: Android 專案骨架`

### Task 2: `Forecast.kt` 純函式（TDD，本計畫的核心）

**Files:** Create `android/app/src/main/java/com/ymeroom/burningsky/Forecast.kt`、
`android/app/src/test/java/com/ymeroom/burningsky/ForecastTest.kt`

**Interfaces (Produces):**
```kotlin
data class LocationScore(val id: String, val name: String, val score: Int, val level: String, val eventTimeMs: Long)
data class Forecast(val generatedAtMs: Long, val locations: List<LocationRow>)
data class LocationRow(val id: String, val name: String, val events: Map<String, EventData>)
data class EventData(val eventTimeMs: Long, val score: Int, val level: String)

fun parseForecast(json: String): Forecast          // 格式錯誤丟 IllegalArgumentException
fun nextEventKind(f: Forecast, nowMs: Long): String?   // "sunset"/"sunrise"/null（無資料）
fun scoresFor(f: Forecast, kind: String): List<LocationScore>  // 依分數由高到低，只含有該場次者
fun isStale(f: Forecast, nowMs: Long): Boolean     // 超過 16 小時
fun eventDateKey(eventTimeMs: Long): String        // 台北時區的 yyyy-MM-dd
fun notifyKey(f: Forecast, kind: String): String?  // "<date>:<kind>"
fun shouldNotify(f: Forecast, kind: String, lastKey: String?, nowMs: Long): Boolean
const val NOTIFY_THRESHOLD = 50
const val STALE_HOURS = 16
```

**測試錨點**（用 spec 附的真實 `data.json` 片段當 fixture，四地點：taipei 有雙場次、
tamsui/gaomei 只有 sunset、wanggaoliao 只有 sunrise）：

- `parseForecast` 正確讀出 4 地點；taipei 有兩場次、gaomei 只有 sunset
- `parseForecast` 對非 JSON、缺 `locations`、`locations` 為空陣列 → 丟 `IllegalArgumentException`
- `nextEventKind`：日落前（12:00）→ `"sunset"`；日落後日出前（20:00）→ `"sunrise"`；全部過去 → 仍回最近者不回 null
- `scoresFor(f,"sunset")` → 3 筆、依分數由高到低（tamsui 41、gaomei 39、taipei 37）
- `scoresFor(f,"sunrise")` → 2 筆，不含 gaomei 與 tamsui
- `isStale`：15.9 小時 false、16.1 小時 true
- `eventDateKey`：`2026-08-12T18:31:00+08:00` → `"2026-08-12"`；跨 UTC 日界的 `2026-08-12T05:26:00+08:00` 仍為 `"2026-08-12"`
- `shouldNotify` 四條規則各一測：最高分 49 → false；最高分 50 → true；
  `lastKey` 等於本次 key → false；事件時刻已過 → false

- [ ] 寫失敗測試 → 紅 → 實作 → `./gradlew test` 綠 → Commit `feat: 預報解析與通知決策純函式`

### Task 3: 抓取與儲存 `Repository.kt`

**Files:** Create `.../Repository.kt`；Modify `ForecastTest.kt`（只測 URL 常數與 key 名稱）

**Interfaces:**
- Consumes: Task 2 的 `parseForecast`
- Produces:
```kotlin
object Repository {
  const val DATA_URL = "https://ymeroom.github.io/taipei-burning-sky/data.json"
  fun fetch(): String                                  // HttpURLConnection GET，逾時 15 秒
  fun save(ctx: Context, json: String)                 // 存原始 JSON 字串
  fun load(ctx: Context): Forecast?                    // 解析失敗回 null（不清掉舊資料）
  fun lastNotifyKey(ctx: Context): String?
  fun setLastNotifyKey(ctx: Context, key: String)
}
```
SharedPreferences 檔名 `burning_sky`；鍵 `forecast_json`、`last_notify_key`。

- [ ] 實作（`load` 以 try/catch 包住解析，失敗回 null 並記 log，**不刪除已存的 JSON**）
- [ ] `./gradlew test` 綠 → Commit `feat: 資料抓取與本機儲存`

### Task 4: Widget 版面與繪製 `BurningSkyWidget.kt`

**Files:** Create `.../BurningSkyWidget.kt`、`res/layout/widget_burning_sky.xml`、
`res/xml/widget_info.xml`、`res/drawable/widget_bg.xml`、`res/values/colors.xml`、
`res/values/strings.xml`；Modify `AndroidManifest.xml`（註冊 receiver）

**Interfaces:**
- Consumes: Task 2 全部純函式、Task 3 的 `Repository.load`
- Produces: `fun updateAllWidgets(ctx: Context)`（供 SyncWorker 呼叫）

**版面**（4×2，深色圓角底 `#10131f`）：
```
下一場・日落  18:32   還有 2 小時 15 分
高美 76    台北 40    淡水 34
                           更新於 15:04
```
- 三個地點欄位以 `LinearLayout` 等寬排列，最多顯示 3 個；最高分者文字用 `#f0805a`，其餘 `#b9c0d6`
- 場次只有兩個地點時（日出場）第三欄隱藏
- `isStale` 為真時右下角改成「⚠ 資料過期」（`#e08a80`）
- 無資料時（首次安裝尚未同步）顯示「載入中…」，不顯示空白
- 整個 widget 設 `PendingIntent` 開啟 `https://ymeroom.github.io/taipei-burning-sky/`
- `widget_info.xml`：`minWidth 250dp`、`minHeight 110dp`、`updatePeriodMillis 0`（更新一律由 WorkManager 驅動）

- [ ] 實作 → `./gradlew assembleDebug` 成功 → Commit `feat: 桌面 widget 版面與繪製`

### Task 5: 排程與通知 `SyncWorker.kt` + `Notifier.kt`

**Files:** Create `.../SyncWorker.kt`、`.../Notifier.kt`；Modify `AndroidManifest.xml`

**Interfaces:**
- Consumes: Task 2、3、4 全部
- Produces:
```kotlin
class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params)
object SyncScheduler { fun ensureScheduled(ctx: Context) }   // 冪等，重複呼叫安全
object Notifier {
  const val CHANNEL_ID = "burning-sky-alert"
  fun ensureChannel(ctx: Context)
  fun notifyBurn(ctx: Context, kind: String, top: LocationScore)
}
```

**SyncWorker 流程**：
1. `fetch()` — 拋例外則回 `Result.retry()`，**不動已存資料**
2. `save(json)`
3. `load()` — 回 null（解析失敗）則記 log 後回 `Result.success()`，不更新 widget、不通知
4. `updateAllWidgets(ctx)`
5. `nextEventKind(f, now)` — **回 null（完全沒有事件資料）時到此為止**，不進通知判斷
6. `shouldNotify(f, kind, Repository.lastNotifyKey(ctx), now)` 為真 →
   `notifyBurn(ctx, kind, scoresFor(f, kind).first())` 並 `setLastNotifyKey(ctx, notifyKey(f, kind)!!)`
7. `Result.success()`

**排程**：`PeriodicWorkRequestBuilder<SyncWorker>(1, TimeUnit.HOURS)`，
`Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED)`，
以 `enqueueUniquePeriodicWork("burning-sky-sync", ExistingPeriodicWorkPolicy.KEEP, req)` 註冊。

**通知內容**：標題 `今晚可能會燒`（sunrise 時為 `明早可能會燒`）；
內文 `${top.name} ${top.score} 分・${top.level}`；第三行 `日落 18:35，還有 3 小時`。
`IMPORTANCE_DEFAULT`、點擊開網站、`setAutoCancel(true)`。

**開機重排**：`BOOT_COMPLETED` receiver 呼叫 `SyncScheduler.ensureScheduled`
（WorkManager 本身會保留，但明確重排較保險）。

- [ ] 實作 → `./gradlew assembleDebug` 成功 → Commit `feat: 每小時同步與高分通知`

### Task 6: 主畫面 `MainActivity.kt`

**Files:** Create `.../MainActivity.kt`、`res/layout/activity_main.xml`；Modify `AndroidManifest.xml`

- 顯示四地點目前分數（讀 `Repository.load`）、資料更新時間
- 「立即更新」按鈕：以 `OneTimeWorkRequest` 觸發 `SyncWorker`
- Android 13+ 首次開啟請求 `POST_NOTIFICATIONS`；被拒絕時顯示一行說明「widget 仍會運作，只是不發通知」
- 啟動時呼叫 `SyncScheduler.ensureScheduled` 與 `Notifier.ensureChannel`

- [ ] 實作 → `./gradlew assembleDebug` 成功 → Commit `feat: 主畫面與通知權限請求`

### Task 7: 實機驗證與文件

**Files:** Modify `README.md`

- [ ] `./gradlew test` 與 `assembleDebug` 全綠
- [ ] 使用者接 USB、開啟開發者模式與 USB 偵錯
- [ ] `adb devices` 確認裝置 → `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`
- [ ] 實機逐項驗證：主畫面顯示四地點分數／「立即更新」有反應／通知權限對話框出現／
      長按桌面加入 widget／widget 顯示下一場與三地分數且最高分加亮／點 widget 開網站
- [ ] 通知驗證：暫時把 `NOTIFY_THRESHOLD` 改成 0 重建安裝，確認通知出現且內容正確，驗完改回 50 重建
- [ ] 過期驗證：把裝置時間往後調 20 小時（或暫改 `STALE_HOURS` 為 0）確認顯示「⚠ 資料過期」，驗完還原
- [ ] README 加「Android App」章節：功能、輪詢與通知規則、建置指令、安裝方式、廠商省電白名單提醒
- [ ] Commit `docs: Android App 說明` 並 push
