// 地面攝影機驗證：讀 ffmpeg 抓下來的一幀 raw RGB，量天空區域的暖色比例 → camBurnIndex
// 用法：node scripts/capture.mjs sunset|sunrise <frame.raw> <width> <height> [YYYY-MM-DD]
//
// 為什麼用地面相機而不是衛星：2026-08-06 實測 NICT 向日葵真彩產品在暮光時段幾乎全黑
// （日落前 10 分視窗最亮像素僅 (60,47,40)，日落當下 (24,13,9)），它是白天可見光合成，
// 拍不到「燒起來」那一刻。地面相機看到的正是肉眼看到的。
//
// 攝影機：日落＝象山看台北 4K（台北觀光官方）、日出＝烘爐地即時影像（新北觀光官方）
import { pathToFileURL } from 'node:url';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { readJsonArray, writeJsonArray, upsertVerification, findTodayPrediction, taipeiToday, VERIFICATION_PATH }
  from './verification.mjs';

const HISTORY_PATH = new URL('../docs/history.json', import.meta.url);

export const CAMERAS = {
  sunset: { id: 'z_fY1pj1VBw', name: '象山看台北' },
  sunrise: { id: 'xxMRjVwCQ3o', name: '烘爐地' },
};

// 天空只佔畫面頂端一小條（象山鏡頭是 101 特寫），且日落時鏡頭會轉向、構圖會變，
// 因此取整個上緣 25% 而非固定小窗——寧可混入一點遠景霧霾，也不要因轉向而完全取錯區域。
export const SKY_FRACTION = 0.25;

// data: 連續 RGB 位元組（ffmpeg -pix_fmt rgb24）。暖像素：R 明顯高於 B 且有一定亮度。
// camBurnIndex：暖色比例 ×2.5 後封頂——整片天燒到 40% 面積即視為滿分。
export function camMetrics(data, width, height, skyFraction = SKY_FRACTION) {
  const rows = Math.max(1, Math.round(height * skyFraction));
  const expected = width * height * 3;
  if (data.length < expected) {
    throw new Error(`camMetrics: 影格位元組不足，需要 ${expected}（${width}×${height}×3），實得 ${data.length}`);
  }
  let total = 0, warm = 0, bright = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      total++;
      if (r > b + 25 && r > 80) warm++;
      if (0.2126 * r + 0.7152 * g + 0.0722 * b > 40) bright++;
    }
  }
  const round3 = v => Math.round(v / total * 1000) / 1000;
  return {
    camWarmRatio: round3(warm),
    camBrightRatio: round3(bright),
    camBurnIndex: Math.round(100 * Math.min(1, warm / total * 2.5)),
  };
}

// 真實霞光是局部、有結構的：2026-08-07 那次確認有燒的日落，暖色只佔天空 17.1%。
// 整片天空均勻轉暖代表的多半不是霞光，而是相機低光源暖色偏移或串流跑出非天空畫面。
// 2026-08-09 日出即為實例：預報 16 分（厚雲、降雨機率 ≥80%），量到 warm 0.991、
// 人眼確認當天完全沒有霞光。這類紀錄照樣存檔，但標記後排除於權重校準之外。
export const SUSPECT_WARM_RATIO = 0.9;

export function isSuspect(metrics) {
  return metrics.camWarmRatio > SUSPECT_WARM_RATIO;
}

// 縮圖存成 docs/frames/<date>-<kind>.jpg，紀錄裡存相對路徑（相對於 docs/，前端可直接連）
export const framePathFor = (date, kind) => `frames/${date}-${kind}.jpg`;

async function main() {
  const [kind, framePath, widthArg, heightArg, dateArg, thumbArg] = process.argv.slice(2);
  if (!CAMERAS[kind]) throw new Error(`用法：node scripts/capture.mjs sunset|sunrise <frame.raw> <w> <h> [date] [thumb.jpg]（實得 ${kind}）`);
  const width = Number(widthArg), height = Number(heightArg);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`capture: 影格尺寸不合法（${widthArg}×${heightArg}）`);
  }
  const date = dateArg || taipeiToday();

  const history = await readJsonArray(HISTORY_PATH);
  const pred = findTodayPrediction(history, kind, date);
  if (!pred) throw new Error(`capture: history 裡找不到 ${date} 的 ${kind} 預測，無可驗證對象`);

  const frame = await readFile(framePath);
  const metrics = camMetrics(frame, width, height);

  // 留一張縮圖，日後出現可疑數值時才有畫面可查——2026-08-09 那筆就是因為沒存畫面而無從查證
  let framePathRel;
  if (thumbArg) {
    framePathRel = framePathFor(date, kind);
    const dest = new URL(`../docs/${framePathRel}`, import.meta.url);
    await mkdir(new URL('../docs/frames/', import.meta.url), { recursive: true });
    await copyFile(thumbArg, dest);
  }

  const suspect = isSuspect(metrics);
  const records = await readJsonArray(VERIFICATION_PATH);
  upsertVerification(records, {
    date, kind,
    eventTime: pred.eventTime,
    predictedScore: pred.predictedScore,
    ...metrics,
    // 這兩個欄位一律寫入：upsert 是 Object.assign，省略鍵會讓舊值殘留，
    // 重跑後量到正常值卻還掛著 suspect 就麻煩了。undefined 會被 JSON.stringify 丟掉。
    suspect: suspect || undefined,
    suspectReason: suspect ? `暖色比例 ${metrics.camWarmRatio} 超過 ${SUSPECT_WARM_RATIO}，整片天均勻轉暖不像真實霞光` : undefined,
    ...(framePathRel ? { frame: framePathRel } : {}),
    camera: CAMERAS[kind].name,
    capturedAt: new Date().toISOString(),
  });
  await writeJsonArray(VERIFICATION_PATH, records);
  console.log(`OK ${date} ${kind} predicted=${pred.predictedScore} camBurnIndex=${metrics.camBurnIndex} warm=${metrics.camWarmRatio} bright=${metrics.camBrightRatio}${suspect ? ' ⚠ 標記為可疑，不列入校準' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exitCode = 1; });
}
