// 權重校準（手動工具，不進排程）：把歷史預測的五因子分數與實況 camBurnIndex 對帳，
// 跑邏輯迴歸看哪些因子真的有預測力，輸出「建議權重」報告。
// 用法：node scripts/calibrate.mjs
//
// 刻意不自動改 score.mjs：權重是這個模型的核心假設，要人看過報告再決定。
import { pathToFileURL } from 'node:url';
import { readJsonArray, VERIFICATION_PATH, DEFAULT_LOCATION_ID } from './verification.mjs';
import { WEIGHTS } from './score.mjs';

const HISTORY_PATH = new URL('../docs/history.json', import.meta.url);
export const MIN_SAMPLES = 40;
export const BURN_THRESHOLD = 25; // camBurnIndex ≥ 25 視為「有燒」
export const FACTOR_KEYS = ['canvas', 'lowCloud', 'clarity', 'aerosol', 'rain'];

// 以 (date, kind) 把歷史預測的因子分數與實況配對；缺 factors 的舊紀錄或未驗證的場次自動略過。
export function joinSamples(history, verifications) {
  const samples = [];
  for (const v of verifications) {
    const burn = v.camBurnIndex;
    if (!Number.isFinite(burn)) continue;
    // 標記為可疑的量測（整片天均勻轉暖，多半是相機偏色而非霞光）不能當標籤用
    if (v.suspect === true) continue;
    // 以 (date, kind, location) 三鍵配對。新格式 history 把各地資料放在 locations[<id>]，
    // 舊格式（多地點之前）欄位在頂層，僅台北有資料。
    const location = v.location ?? DEFAULT_LOCATION_ID;
    const factors = history.reduce((found, h) => {
      const entry = h.locations ? h.locations[location] : (location === DEFAULT_LOCATION_ID ? h : null);
      if (!entry) return found;
      const t = entry[`${v.kind}Time`];
      return (typeof t === 'string' && t.slice(0, 10) === v.date && entry[`${v.kind}Factors`])
        ? entry[`${v.kind}Factors`] : found;
    }, null);
    if (!factors) continue;
    if (!FACTOR_KEYS.every(k => Number.isFinite(factors[k]))) continue;
    samples.push({
      date: v.date, kind: v.kind, location,
      x: FACTOR_KEYS.map(k => factors[k]),
      y: burn >= BURN_THRESHOLD ? 1 : 0,
    });
  }
  return samples;
}

// 逐欄標準化（z-score）。標準差為 0 的欄位（該因子從沒變動過）整欄歸零，係數自然也會是 0。
export function standardize(rows) {
  const n = rows.length, dim = rows[0].length;
  const mean = Array.from({ length: dim }, (_, j) => rows.reduce((s, r) => s + r[j], 0) / n);
  const std = Array.from({ length: dim }, (_, j) =>
    Math.sqrt(rows.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / n) || 0);
  const scaled = rows.map(r => r.map((v, j) => (std[j] === 0 ? 0 : (v - mean[j]) / std[j])));
  return { scaled, mean, std };
}

// 手寫邏輯迴歸（梯度下降），零依賴。回傳標準化尺度下的係數與截距。
export function logisticRegression(X, y, { iterations = 5000, learningRate = 0.1 } = {}) {
  const n = X.length, dim = X[0].length;
  const w = new Array(dim).fill(0);
  let b = 0;
  for (let it = 0; it < iterations; it++) {
    const gw = new Array(dim).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((s, v, j) => s + v * w[j], b);
      const err = 1 / (1 + Math.exp(-z)) - y[i];
      for (let j = 0; j < dim; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < dim; j++) w[j] -= learningRate * gw[j] / n;
    b -= learningRate * gb / n;
  }
  return { coefficients: w, intercept: b };
}

// 係數 → 建議權重：取正係數的相對大小按總分 100 分配（負係數視為無預測力，給 0）。
// 用最大餘額法而非逐項四捨五入——權重總和必須恰好是 100，才對得上評分模型的滿分。
export function suggestWeights(coefficients) {
  const positive = coefficients.map(c => Math.max(0, c));
  const sum = positive.reduce((a, b) => a + b, 0);
  if (sum === 0) return FACTOR_KEYS.map(() => 0);

  const exact = positive.map(c => 100 * c / sum);
  const weights = exact.map(Math.floor);
  let remainder = 100 - weights.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0; k = (k + 1) % byRemainder.length, remainder--) {
    weights[byRemainder[k].i]++;
  }
  return weights;
}

export function countSuspect(verifications) {
  return verifications.filter(v => v.suspect === true).length;
}

// 四地點合併擬合（物理模型相同），但記錄各地筆數以便日後決定要不要分開
export function countByLocation(samples) {
  const out = {};
  for (const s of samples) {
    const k = s.location ?? DEFAULT_LOCATION_ID;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function report(samples, suspectCount = 0) {
  const positives = samples.filter(s => s.y === 1).length;
  const lines = [`配對樣本 ${samples.length} 筆（有燒 ${positives}、沒燒 ${samples.length - positives}）`];
  const byLoc = countByLocation(samples);
  lines.push('各地點樣本數：' + Object.entries(byLoc).map(([k, n]) => `${k} ${n}`).join('、'));
  if (suspectCount > 0) lines.push(`另有 ${suspectCount} 筆標記為可疑，已排除`);
  if (positives === 0 || positives === samples.length) {
    lines.push('實況標籤全部相同，無法迴歸——再累積幾天有變化的資料再跑。');
    return lines.join('\n');
  }
  const { scaled, std } = standardize(samples.map(s => s.x));
  const { coefficients } = logisticRegression(scaled, samples.map(s => s.y));
  const suggested = suggestWeights(coefficients);
  lines.push('', '因子        現行權重  迴歸係數   建議權重  備註');
  FACTOR_KEYS.forEach((key, j) => {
    const note = std[j] === 0 ? '此因子分數從未變動，無資訊'
      : coefficients[j] < 0 ? '與實況呈負相關，方向可能反了'
      : '';
    lines.push(`${key.padEnd(11)} ${String(WEIGHTS[key]).padStart(6)} ${coefficients[j].toFixed(3).padStart(10)} ${String(suggested[j]).padStart(9)}  ${note}`);
  });
  lines.push('', '這是建議不是決定：權重是模型的核心假設，請人看過再改 scripts/score.mjs 的 WEIGHTS。');
  return lines.join('\n');
}

async function main() {
  const [history, verifications] = await Promise.all([
    readJsonArray(HISTORY_PATH),
    readJsonArray(VERIFICATION_PATH),
  ]);
  const samples = joinSamples(history, verifications);
  const suspectCount = countSuspect(verifications);
  if (samples.length < MIN_SAMPLES) {
    const note = suspectCount > 0 ? `，另有 ${suspectCount} 筆可疑已排除` : '';
    console.log(`資料不足（目前 ${samples.length} 筆${note}，需要 ${MIN_SAMPLES} 筆）。繼續累積，過幾週再跑。`);
    return;
  }
  console.log(report(samples, suspectCount));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exitCode = 1; });
}
