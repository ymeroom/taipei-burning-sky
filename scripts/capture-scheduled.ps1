<#
.SYNOPSIS
  Windows 工作排程器用的包裝腳本：等到日落／日出時刻後 8 分鐘抓一幀直播畫面，算 camBurnIndex，commit 並 push。

.DESCRIPTION
  排程器只能設固定時間，但日出日落每天都在移動，所以這支腳本提早開工、
  從 docs/data.json 讀當天的實際事件時刻，再睡到定點才抓。
  電腦當時關機／睡著而錯過窗口的話，會記一筆 log 後正常結束，不算失敗。

.PARAMETER Kind
  sunset 或 sunrise。

.PARAMETER Now
  跳過等待，立刻抓一幀（測試用）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\capture-scheduled.ps1 -Kind sunset
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('sunset', 'sunrise')][string]$Kind,
  [switch]$Now
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# Git Bash 與 node 都輸出 UTF-8；不改主控台編碼的話，子行程的中文寫進 log 會變亂碼
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("capture-{0}.log" -f (Get-Date -Format 'yyyy-MM'))

function Write-Log($msg) {
  $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Kind, $msg
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Host $line
}

# Git Bash：capture-local.sh 需要它（yt-dlp／ffmpeg 管線）
$bash = 'C:\Program Files\Git\bin\bash.exe'
if (-not (Test-Path $bash)) { Write-Log "找不到 Git Bash：$bash"; exit 1 }

try {
  Write-Log '開始，先同步遠端'
  git pull --rebase --autostash --quiet 2>&1 | ForEach-Object { Write-Log $_ }

  $dataPath = Join-Path $repo 'docs\data.json'
  if (-not (Test-Path $dataPath)) { Write-Log 'docs/data.json 不存在，先跑 update.mjs'; exit 1 }
  $data = Get-Content $dataPath -Raw | ConvertFrom-Json
  $eventTime = [datetimeoffset]::Parse($data.next.$Kind.eventTime)
  $target = $eventTime.AddMinutes(8)
  $waitSec = [int]($target - [datetimeoffset]::Now).TotalSeconds
  Write-Log ("事件 {0}，目標抓幀 {1}，需等待 {2} 秒" -f $eventTime.ToString('yyyy-MM-dd HH:mm'), $target.ToString('HH:mm'), $waitSec)

  if (-not $Now) {
    if ($waitSec -lt -1800) { Write-Log '已錯過抓幀窗口 30 分鐘以上（電腦當時可能沒開），本次略過'; exit 0 }
    if ($waitSec -gt 10800) { Write-Log '距離事件超過 3 小時，排程時間設定可能有誤，本次略過'; exit 0 }
    if ($waitSec -gt 0) { Start-Sleep -Seconds $waitSec }
  }

  Write-Log '抓幀並計算 camBurnIndex'
  & $bash -lc "cd '$($repo -replace '\\','/')' && bash scripts/capture-local.sh $Kind" 2>&1 | ForEach-Object { Write-Log $_ }
  if ($LASTEXITCODE -ne 0) { Write-Log "capture-local.sh 失敗（exit $LASTEXITCODE）"; exit 1 }

  git add docs/verification.json docs/frames
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    git commit -q -m "chore: $Kind 實況驗證資料"
    git pull --rebase --autostash --quiet
    git push --quiet
    Write-Log '已 commit 並 push'
  } else {
    Write-Log '資料沒有變化，略過 commit'
  }
  Write-Log '完成'
} catch {
  Write-Log "錯誤：$($_.Exception.Message)"
  exit 1
}
