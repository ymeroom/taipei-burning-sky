// 地面攝影機驗證：讀 ffmpeg 抓下來的 raw RGB 影格，量天空區域的暖色比例 → camBurnIndex
// 用法：node scripts/capture.mjs sunset|sunrise <frame.raw> <w> <h> [YYYY-MM-DD] [thumb.jpg] [locationId]
//
// 為什麼用地面相機而不是衛星：2026-08-06 實測 NICT 向日葵真彩產品在暮光時段幾乎全黑
// （日落前 10 分視窗最亮像素僅 (60,47,40)，日落當下 (24,13,9)），它是白天可見光合成，
// 拍不到「燒起來」那一刻。地面相機看到的正是肉眼看到的。
//
// 各地鏡頭一律查 locations.mjs，本檔不再自帶鏡頭清單。
import { pathToFileURL } from 'node:url';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { readJsonArray, writeJsonArray, upsertVerification, findTodayPrediction, taipeiToday, VERIFICATION_PATH }
  from './verification.mjs';
import { locationById, DEFAULT_LOCATION } from './locations.mjs';

const HISTORY_PATH = new URL('../docs/history.json', import.meta.url);

// 取該地該場次的鏡頭；地點或場次不存在都要大聲失敗，不要默默抓錯鏡頭
export function cameraFor(locationId, kind) {
  const loc = locationById(locationId);
  const cam = loc.events[kind];
  if (!cam) throw new Error(`cameraFor: ${locationId} 沒有 ${kind} 場次`);
  return cam;
}

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

// ---- 無訊號偵測（主要防線）----
//
// 2026-08-09 日出量到 camBurnIndex 100，實際上鏡頭當時播的是新北觀旅局的
// 「Cam Under Maintenance」待機卡——而那張卡的底圖剛好是一張夕陽照，上緣整片橘紅。
// 待機卡是靜止圖，真實鏡頭則永遠有像素在變，以此判定比看顏色可靠。
//
// 判準用「最大差異」而非平均：平均會被大量沒變的像素稀釋，隨場景動態劇烈變化——
// 實測同一支烘爐地鏡頭，霧雨天 MAD 19.9、平靜晴晨只有 0.18，差兩個數量級，
// 任何固定門檻都會在其中一端出錯（2026-08-10 日出即因門檻設 1.0 而被誤判為無訊號）。
// 最大差異則是類別性的：平靜晴晨仍有 45，真正的靜止圖精確為 0。
export function frameDiff(a, b) {
  if (a.length !== b.length) {
    throw new Error(`frameDiff: 兩幀長度不同（${a.length} vs ${b.length}）`);
  }
  let sum = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
  }
  return { mean: Math.round(sum / a.length * 1000) / 1000, max };
}

// 把多幀 raw buffer 依尺寸切開
export function splitFrames(data, width, height) {
  const size = width * height * 3;
  const count = Math.floor(data.length / size);
  return Array.from({ length: count }, (_, i) => data.subarray(i * size, (i + 1) * size));
}

// 完全相同才算靜止。差一個像素就代表鏡頭是活的。
export function isStatic(frames) {
  if (frames.length < 2) return false; // 只有一幀就無從判斷，不亂猜
  return frameDiff(frames[0], frames[1]).max === 0;
}

// ---- 顏色合理性（次要防線）----
// 真實霞光是局部、有結構的：2026-08-07 那次確認有燒的日落，暖色只佔天空 17.1%。
// 整片天均勻轉暖仍值得存疑，留作無訊號偵測失效時的後備。
export const SUSPECT_WARM_RATIO = 0.9;

export function isSuspect(metrics) {
  return metrics.camWarmRatio > SUSPECT_WARM_RATIO;
}

// 縮圖存成 docs/frames/<date>-<location>-<kind>.jpg，紀錄裡存相對路徑（相對於 docs/，前端可直接連）
export const framePathFor = (date, location, kind) => `frames/${date}-${location}-${kind}.jpg`;

async function main() {
  const [kind, framePath, widthArg, heightArg, dateArg, thumbArg, locArg] = process.argv.slice(2);
  const locationId = locArg || DEFAULT_LOCATION;
  const camera = cameraFor(locationId, kind); // 地點或場次不對就在這裡失敗
  const width = Number(widthArg), height = Number(heightArg);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`capture: 影格尺寸不合法（${widthArg}×${heightArg}）`);
  }
  const date = dateArg || taipeiToday();

  const history = await readJsonArray(HISTORY_PATH);
  const pred = findTodayPrediction(history, kind, date, locationId);
  if (!pred) throw new Error(`capture: history 裡找不到 ${date} ${locationId} 的 ${kind} 預測，無可驗證對象`);

  const raw = await readFile(framePath);
  const frames = splitFrames(raw, width, height);
  if (frames.length === 0) throw new Error(`capture: 影格檔案太小（${raw.length} bytes，單幀需 ${width * height * 3}）`);
  const metrics = camMetrics(raw, width, height);

  // 靜止畫面＝待機卡或串流凍結，量到什麼顏色都不算數。
  // 差異數值一併存檔：日後若要重新檢討判準，才不必再靠猜的。
  const diff = frames.length >= 2 ? frameDiff(frames[0], frames[1]) : null;
  const noSignal = isStatic(frames);

  // 留一張縮圖，日後出現可疑數值時才有畫面可查——2026-08-09 那筆就是因為沒存畫面而無從查證
  let framePathRel;
  if (thumbArg) {
    framePathRel = framePathFor(date, locationId, kind);
    const dest = new URL(`../docs/${framePathRel}`, import.meta.url);
    await mkdir(new URL('../docs/frames/', import.meta.url), { recursive: true });
    await copyFile(thumbArg, dest);
  }

  const suspect = noSignal || isSuspect(metrics);
  const reason = noSignal
    ? `畫面靜止（相隔三秒兩幀完全相同，最大差異 0），判定為待機卡或串流凍結，不是真實天空`
    : `暖色比例 ${metrics.camWarmRatio} 超過 ${SUSPECT_WARM_RATIO}，整片天均勻轉暖不像真實霞光`;

  const records = await readJsonArray(VERIFICATION_PATH);
  upsertVerification(records, {
    date, kind, location: locationId,
    eventTime: pred.eventTime,
    predictedScore: pred.predictedScore,
    ...metrics,
    // 這兩個欄位一律寫入：upsert 是 Object.assign，省略鍵會讓舊值殘留，
    // 重跑後量到正常值卻還掛著 suspect 就麻煩了。undefined 會被 JSON.stringify 丟掉。
    frameDiffMean: diff ? diff.mean : undefined,
    frameDiffMax: diff ? diff.max : undefined,
    suspect: suspect || undefined,
    suspectReason: suspect ? reason : undefined,
    noSignal: noSignal || undefined,
    ...(framePathRel ? { frame: framePathRel } : {}),
    camera: camera.cameraName,
    capturedAt: new Date().toISOString(),
  });
  await writeJsonArray(VERIFICATION_PATH, records);
  const flag = noSignal ? ' ⚠ 無訊號（待機卡／凍結），不列入校準'
    : suspect ? ' ⚠ 標記為可疑，不列入校準' : '';
  console.log(`OK ${date} ${locationId} ${kind} predicted=${pred.predictedScore} camBurnIndex=${metrics.camBurnIndex} warm=${metrics.camWarmRatio} bright=${metrics.camBrightRatio}${flag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exitCode = 1; });
}
