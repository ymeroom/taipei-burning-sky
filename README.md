# 火燒雲預報 🌇

每日台北時間 **15:00**（今晚日落）與 **23:30**（明早日出）自動更新，
預測四個地點日出／日落出現火燒雲的機率。

**網站：** https://ymeroom.github.io/taipei-burning-sky/

## 地點

| id | 地點 | 場次 | 驗證鏡頭 |
|---|---|---|---|
| `taipei` | 台北市中心 | 日落・日出 | 象山看台北／烘爐地 |
| `tamsui` | 淡水漁人碼頭 | 日落 | 淡水漁人碼頭（新北旅客） |
| `gaomei` | 高美濕地 | 日落 | 高美濕地 4K（台中觀光） |
| `wanggaoliao` | 望高寮 | 日出 | 望高寮 4K（台中觀光） |

每個地點只計算它實際適合的場次——高美濕地是西向夕陽點，替它產生日出分數只是噪音。
座標、鏡頭 id 全部集中在 `scripts/locations.mjs`，新增地點或補場次改那個檔就好。

不管幾個地點，Open-Meteo 呼叫數都維持 **3 次**（天氣、空品、光路各一次批次）。
三個批次回應在 `assembleBatches` 一處對位回地點——錯位不會拋錯，只會安靜地把某地的天氣
算成另一地的分數，所以測試用四地點各餵不同雲量來鎖住這件事。

## 運作方式

GitHub Actions 依排程執行 `scripts/update.mjs`：

1. 抓取 [Open-Meteo](https://open-meteo.com/) 天氣預報（分層雲量、濕度、能見度、降雨機率、日出日落時刻）與空氣品質（氣溶膠光學厚度 AOD）
2. 以事件時刻做線性插值，五因子加權評分（滿分 100）：
   中高雲畫布 40・低雲阻擋 25・空氣通透度 15・氣溶膠 10・降雨干擾 10
3. 寫入 `docs/data.json`（最新預測）與 `docs/history.json`（歷史紀錄），commit 後 GitHub Pages 自動重新發佈

等級：0–24 別期待｜25–49 普通｜50–74 值得一看｜75–100 大燒預警

### 光路取樣

低雲阻擋不只看市區單點。`scripts/geo.mjs` 算出事件時刻的太陽方位角（NOAA 演算法），
沿該方向取 40／90／150／220／300 公里五個點（日落往西進台灣海峽、日出往東出太平洋，逐日隨季節擺動），
以 0.30／0.25／0.20／0.15／0.10 加權後，與市中心以 6:4 混合成「有效低雲」。

理由：霞光是陽光從地平線下方斜射、穿過數百公里低空後打在雲底的結果。
台北頭頂沒有低雲不代表光進得來——光路上任何一段有低雲都會擋掉。

## 實況驗證與權重校準

模型權重目前是依物理常識設定的，還沒有用實際結果驗證過。驗證管線：

- `scripts/capture.mjs`：讀一幀地面直播畫面（raw RGB），量天空區域的暖色比例 → `camBurnIndex`
- `scripts/capture-local.sh`：本機一鍵抓幀＋計算，寫進 `docs/verification.json`
- `scripts/calibrate.mjs`：累積 40 筆以上配對資料後，跑邏輯迴歸輸出「建議權重」報告（**不自動改** `score.mjs`）

攝影機：日落＝象山看台北（台北觀光官方）、日出＝烘爐地（新北觀光官方）。

每次抓幀會另存一張 160px 縮圖到 `docs/frames/<date>-<location>-<kind>.jpg`（約 1–2KB），供日後查證可疑數值。

### 兩道防線：擋掉待機卡與凍結畫面

**主要防線是「畫面有沒有在動」。** 抓幀一次取相隔三秒的兩幀，**完全相同**（最大差異為 0）
才判定 `noSignal`。這比看顏色可靠，也不會誤殺真正的滿天大燒。

判準刻意用「最大差異」而非平均：平均會被大量沒變的像素稀釋，隨場景動態劇烈變化——
實測同一支烘爐地鏡頭，霧雨天 MAD 19.9、平靜晴晨只有 0.18，差兩個數量級。
最初用平均門檻 1.0，隔天就把 2026-08-10 一筆正常的日出資料誤判成無訊號。
最大差異則是類別性的：平靜晴晨仍有 45（6.8% 像素在變），真正的靜止圖精確為 0。
每筆紀錄一併存下 `frameDiffMean` 與 `frameDiffMax`，日後要重新檢討判準才不必再靠猜。

**次要防線是顏色合理性**：`camWarmRatio > 0.9` 標記 `suspect`。真實霞光是局部的
（2026-08-07 那次確認有燒的日落只有 17.1%），留作主要防線失效時的後備。

兩種標記的紀錄照樣存檔（含縮圖），但 `calibrate.mjs` 一律排除。

**2026-08-09 日出就是這麼發現的**：預報 16 分（厚雲、降雨機率 ≥80%）卻量到 `camBurnIndex 100`。
原因是鏡頭當時播放新北觀旅局的「Cam Under Maintenance」待機卡，而那張卡的底圖是一張夕陽照，
上緣整片橘紅。當時既沒存畫面也沒有靜止偵測，是使用者自己去看直播才查出來的——
這兩道防線就是為此補上的。

### 直播回捲：DVR 窗口 4 小時（2026-08-11 實測）

五支鏡頭的 HLS 播放清單都恰好保留 **4.00 小時**（2881 段 × 5 秒）。在這個窗口內可以回捲抓任意時刻的畫面：
解析 m3u8 → 用 `EXT-X-PROGRAM-DATE-TIME` 加各段 `EXTINF` 長度算出索引 → 直接下載那個 `.ts` 片段抓幀。
實測命中兩小時前的目標時間誤差 1.1 秒。超過 4 小時就抓不到了——2026-08-09 那次想回頭查證失敗，正是因為隔了 4.6 小時。

**曾評估但未採用的設計**：不在事件當下抓幀，改成事後回捲、每分鐘取一幀掃完整個霞光窗口，取最大值當標籤。
優點是能抓到峰值（現在只取事件 +8 分那一瞬間，峰值時間每天不同，等於抽獎）、順便得到時間曲線、
對待機卡免疫、排程不必長時間睡著。代價是流量（426×240 約 156KB／段，60 幀約 9MB，一天五場次約 47MB）
與程式複雜度，而且 4 小時窗口仍解不了「電腦隔天早上才開機」的情況。
若日後要重啟這個方向，上面的數字都已量測過，不必重查。

### 查縮圖時怎麼認待機卡

**看有沒有文字。** 待機卡上有「Cam Under Maintenance」與「新北市政府觀光旅遊局／因網路與電力因素
影像暫停服務」的字樣，真實畫面則沒有。這比推敲數值可靠，是判讀縮圖時的第一順位依據。

尚待驗證的一點：靜止偵測**還沒有在真實待機卡上驗證過**。2026-08-09 那次是單幀抓取，沒留下
`frameDiffMax`，所以不知道那張卡在串流裡是否真的完全靜止。實際攔下它的是暖色比例那道防線
（底圖恰為夕陽照）。若哪天底圖換成藍天，兩道防線可能同時失效。
現在每筆都會記錄 `frameDiffMax`，待機卡下次出現時即可確認第一道防線是否有效。

```bash
bash scripts/capture-local.sh sunset '' gaomei   # 手動抓某地某場次
node scripts/calibrate.mjs              # 資料夠了再跑
```

### 自動排程（Windows）

`scripts/capture-scheduled.ps1` 是給工作排程器用的包裝：先 `git pull`，從 `docs/data.json`
讀出該場次**所有地點**的事件時刻並依序處理：睡到各地事件後 8 分鐘才抓幀，全部完成後 commit 並 push。
單一地點失敗（鏡頭掛掉、錯過窗口）記 log 後繼續下一個，不中斷整批，全程寫進 `logs/capture-YYYY-MM.log`。
電腦當時關機而錯過窗口 30 分鐘以上時，記一筆 log 後正常結束，不算失敗。

註冊兩個每日工作（時間刻意早於全年最早的事件，等待交給腳本處理）：

```powershell
$s = 'D:\taipei-burning-sky\scripts\capture-scheduled.ps1'
foreach ($j in @(@{N='BurningSky-Sunset';K='sunset';T='16:45'}, @{N='BurningSky-Sunrise';K='sunrise';T='04:50'})) {
  Register-ScheduledTask -TaskName $j.N -Force `
    -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$s`" -Kind $($j.K)") `
    -Trigger (New-ScheduledTaskTrigger -Daily -At $j.T) `
    -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew) `
    -Principal (New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited)
}
```

工作以「使用者登入時執行」身分跑，才拿得到 Windows 認證管理員裡的 git 憑證。
手動測試：`powershell -ExecutionPolicy Bypass -File scripts\capture-scheduled.ps1 -Kind sunset -Now`（`-Now` 跳過等待）。

注意：`.ps1` 必須存成帶 BOM 的 UTF-8，否則 Windows PowerShell 5.1 會用 ANSI 讀檔、中文字被打碎導致語法錯誤。

#### 已知的漏拍模式

實況驗證這半套跑在本機，所以受制於機器狀態。目前觀察到三種漏拍：

| 模式 | 徵狀 | 實例 |
|---|---|---|
| 電腦沒開 | 補跑時已超過窗口 30 分鐘 → 各地點逐一略過，exit 1 | 2026-08-11 日出（11:08 才補跑，事件 05:26） |
| 等待中被中斷 | log 停在「需等待 N 秒」就沒下文，exit `0x40010004` | 2026-08-11 日落（16:45 啟動，睡到 18:40 途中斷電） |
| 鏡頭待機卡 | 抓到畫面但被兩道防線標記，不列入校準 | 2026-08-09 日出（烘爐地維修卡） |

第二種最傷：日落場一掛就是三個地點一起沒，而且腳本沒機會寫失敗訊息。
成因是現在的設計要求機器連續清醒近兩小時（16:45 啟動、18:40 才抓）。

**尚未採用的兩個緩解方向**（依成本排序）：
1. 多加幾個觸發時間（16:45／17:45／18:20），配合 `MultipleInstances IgnoreNew`——
   先啟動的活著就照跑，被殺掉才由後面的接手，等待時間越短越不容易被打斷。零程式碼變更。
2. 改用 DVR 回捲（見上節），完全不需要等待，4 小時內醒來都補得到。

### 兩個實測結論（2026-08-06）

**衛星驗證行不通。** NICT 向日葵真彩產品在暮光時段幾乎全黑——台北視窗在日落前 10 分最亮像素只有
`(60,47,40)`，日落當下 `(24,13,9)`。它是白天可見光合成，沒有暮光增強，拍不到「燒起來」那一刻；
往前挪到照度足夠的時間（日落前 45 分以上）雲場又已改變，失去驗證意義。因此不採用。

**攝影機抓幀無法在 GitHub Actions 上跑。** YouTube 擋機房 IP，runner 上 yt-dlp 回
`Sign in to confirm you're not a bot`（實測 run 31080972665）。同一條管線在家用網路完全正常，
所以 `.github/workflows/capture.yml` 的排程已停用，改用本機腳本。
若日後換成不需登入的公開影像來源，把該檔的 `schedule` 解除註解即可。

## Android App

桌面 widget 顯示下一場日出／日落各地分數，任一地點 ≥50 分時發通知。
原始碼在 `android/`，applicationId `com.ymeroom.burningsky`。

**不需要推播伺服器**：`data.json` 已是公開靜態檔，App 用 WorkManager 每小時自己抓，
抓到高分再發本機通知。沒有 Firebase、沒有金鑰、沒有後端。

| 行為 | 規則 |
|---|---|
| 輪詢 | 每小時一次，需有網路。不對準 15:00／23:30，因為 Actions cron 實測延遲 1–2.5 小時 |
| 通知門檻 | 任一地點 ≥50 分（值得一看） |
| 通知去重 | 以 `<事件日期>:<場次>` 為鍵，同一場只發一次 |
| widget 內容 | 下一場的場次、時刻、倒數，各地分數由高到低，最高分加亮 |
| 過期 | `generatedAt` 超過 16 小時顯示「⚠ 資料過期」（與網站同判準） |
| 抓取失敗 | 沿用快取資料，WorkManager 退避重試，絕不顯示空白 |

相依只有 `androidx.core-ktx` 與 `androidx.work`——widget 用傳統 RemoteViews 而非
Compose／Glance，APK 約 2.4MB。所有判斷邏輯集中在 `Forecast.kt`（不 import 任何
`android.*`），因此能在電腦上用 JUnit 驗證，共 24 條測試。

### 建置與安裝

```bash
cd android
JAVA_HOME="C:/Program Files/Android/Android Studio/jbr" ./gradlew test assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Gradle 8.2 + AGP 8.1.4（本機已快取 Gradle 8.2，不需另外下載）。
debug keystore 在此機器上固定，更新可直接覆蓋安裝。非上架用途，不需 release 簽章。

開啟 App 後按「把 widget 加到桌面」即可加入，比自己長按桌面翻小工具清單快。

### 實機驗證發現的四個問題（2026-08-12，Galaxy Note 10+／Android 12）

單元測試涵蓋不到的部分，只有真機才會現形：

1. **背景同步後畫面不重畫**——`render()` 只在 `onResume` 跑一次，資料晚一步到就看不到。
   改用 SharedPreferences 變更監聽。
2. **最高分加亮邏輯是反的**——低分等級色（`lv1 #8b94b2`）比次要文字色（`#b9c0d6`）更暗，
   導致 48 分看起來比旁邊的 37、35 還不起眼。改為低於 50 分時用中性亮色，
   暖色只在真的值得出門時出現。
3. **通知圖示變成實心方塊**——Android 只取小圖示的 alpha 通道當剪影，
   原本沿用不透明的 launcher icon 就整塊糊掉。改用透明底的白色向量圖。
4. **更新 App 後 widget 卡在「載入中」**——桌面會退回 `initialLayout`，
   而該版面頁尾預設就是這行字，要等下次輪詢（最多一小時）才恢復。
   補上 `MY_PACKAGE_REPLACED` 廣播與開啟 App 時的重畫。

### 已知限制

- **預測模型尚未校準**（目前 8/40 筆），通知依未驗證的分數發出，可能誤報或漏報。
  校準完成後 App 不需改動。
- Doze 模式可能讓輪詢延後，最壞情況通知比預報晚一兩小時。
- 小米、OPPO 等廠商的省電機制較積極，可能需要手動把 App 加入白名單。

## 本機開發

```bash
node --test                 # 單元測試（128 條）
node scripts/update.mjs     # 手動抓一次資料
npx http-server docs        # 本機預覽
```

`scripts/capture-local.sh` 需要 `python -m pip install yt-dlp` 與 PATH 上的 `ffmpeg`。

僅供參考——天空從不照劇本走。
