# 台北火燒雲預報 🌇

每日台北時間 **15:00**（今晚日落）與 **23:30**（明早日出）自動更新，
預測台北市日出／日落出現火燒雲的機率。

**網站：** https://ymeroom.github.io/taipei-burning-sky/

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

每次抓幀會另存一張 160px 縮圖到 `docs/frames/<date>-<kind>.jpg`（約 1–2KB），供日後查證可疑數值。

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

```bash
bash scripts/capture-local.sh sunset    # 日落後約 8 分鐘跑
node scripts/calibrate.mjs              # 資料夠了再跑
```

### 自動排程（Windows）

`scripts/capture-scheduled.ps1` 是給工作排程器用的包裝：先 `git pull`，從 `docs/data.json`
讀當天的實際事件時刻，睡到事件後 8 分鐘才抓幀，完成後 commit 並 push，全程寫進 `logs/capture-YYYY-MM.log`。
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

### 兩個實測結論（2026-08-06）

**衛星驗證行不通。** NICT 向日葵真彩產品在暮光時段幾乎全黑——台北視窗在日落前 10 分最亮像素只有
`(60,47,40)`，日落當下 `(24,13,9)`。它是白天可見光合成，沒有暮光增強，拍不到「燒起來」那一刻；
往前挪到照度足夠的時間（日落前 45 分以上）雲場又已改變，失去驗證意義。因此不採用。

**攝影機抓幀無法在 GitHub Actions 上跑。** YouTube 擋機房 IP，runner 上 yt-dlp 回
`Sign in to confirm you're not a bot`（實測 run 31080972665）。同一條管線在家用網路完全正常，
所以 `.github/workflows/capture.yml` 的排程已停用，改用本機腳本。
若日後換成不需登入的公開影像來源，把該檔的 `schedule` 解除註解即可。

## 本機開發

```bash
node --test                 # 單元測試（83 條）
node scripts/update.mjs     # 手動抓一次資料
npx http-server docs        # 本機預覽
```

`scripts/capture-local.sh` 需要 `python -m pip install yt-dlp` 與 PATH 上的 `ffmpeg`。

僅供參考——天空從不照劇本走。
