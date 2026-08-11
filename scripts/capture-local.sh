#!/usr/bin/env bash
# 在本機抓一幀直播畫面並算 camBurnIndex，寫進 docs/verification.json。
# 為什麼在本機而不是 GitHub Actions：YouTube 擋機房 IP（runner 上回 "Sign in to confirm you're not a bot"），
# 家用網路則完全正常。
#
# 用法：bash scripts/capture-local.sh sunset|sunrise [YYYY-MM-DD] [locationId]
#   locationId 預設 taipei，可用值見 scripts/locations.mjs
# 需求：python -m pip install yt-dlp、ffmpeg 在 PATH 上
# 建議：用 scripts/capture-scheduled.ps1 搭配 Windows 工作排程器，它會依序處理所有地點
set -euo pipefail

KIND="${1:-}"
DATE_ARG="${2:-}"
LOCATION="${3:-taipei}"
[ "$KIND" = "sunset" ] || [ "$KIND" = "sunrise" ] || { echo "用法：bash scripts/capture-local.sh sunset|sunrise [YYYY-MM-DD] [locationId]" >&2; exit 1; }

cd "$(dirname "$0")/.."

# 鏡頭一律查 locations.mjs；地點或場次不存在會在這裡就失敗
CAM=$(node --input-type=module -e "
  const {cameraFor}=await import('./scripts/capture.mjs');
  const c=cameraFor('$LOCATION','$KIND');
  console.log(c.camera+'	'+c.cameraName)")
VIDEO=$(printf '%s' "$CAM" | cut -f1)
CAMNAME=$(printf '%s' "$CAM" | cut -f2)
echo "地點 $LOCATION（$CAMNAME）場次 $KIND，攝影機 https://www.youtube.com/watch?v=$VIDEO"

STREAM=$(python -m yt_dlp -g -f 'best[height<=720]' "https://www.youtube.com/watch?v=$VIDEO" 2>/dev/null | tail -1)
[ -n "$STREAM" ] || { echo "取不到串流網址（yt-dlp 失敗）" >&2; exit 1; }

FRAME=$(mktemp -t frame-XXXXXX.raw)
THUMB=$(mktemp -t thumb-XXXXXX.jpg)
trap 'rm -f "$FRAME" "$THUMB"' EXIT

# 一次輸入、兩個輸出：raw 取相隔三秒的兩幀（供靜止畫面偵測），jpg 留存以便日後查證
ffmpeg -loglevel error -y -i "$STREAM" \
  -vf "fps=1/3,scale=320:-1" -frames:v 2 -f rawvideo -pix_fmt rgb24 "$FRAME" \
  -vf scale=160:-1 -frames:v 1 -q:v 6 "$THUMB"

BYTES=$(wc -c < "$FRAME")
HEIGHT=$(( BYTES / 320 / 3 / 2 ))
[ "$HEIGHT" -gt 0 ] || { echo "抓幀失敗（$BYTES bytes）" >&2; exit 1; }
echo "抓到 2 幀 320×${HEIGHT} 影格，縮圖 $(wc -c < "$THUMB") bytes"

# 日期留空字串即由 capture.mjs 以台北時區自行判定；縮圖必須放在日期之後的位置
node scripts/capture.mjs "$KIND" "$FRAME" 320 "$HEIGHT" "$DATE_ARG" "$THUMB" "$LOCATION"

echo "完成。記得 commit 並 push docs/verification.json 讓網站顯示實況。"
