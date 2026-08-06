// 抓 Open-Meteo 天氣 + 空品 + 光路批次 → 算下一場日出/日落火燒雲分數 → 寫 docs/data.json、append docs/history.json
// 用法：node scripts/update.mjs [trigger]   trigger ∈ sunset-run | sunrise-run | manual
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { scoreEvent, interpolate } from './score.mjs';
import { sunAzimuthAt, destinationPoint } from './geo.mjs';

const LAT = 25.04, LON = 121.56;
const FORECAST_URL = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
  + `&hourly=cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,visibility,precipitation_probability`
  + `&daily=sunrise,sunset&timezone=Asia%2FTaipei&forecast_days=5`;
const AIR_URL = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT}&longitude=${LON}`
  + `&hourly=aerosol_optical_depth&timezone=Asia%2FTaipei&forecast_days=5`;

const DATA_PATH = new URL('../docs/data.json', import.meta.url);
const HISTORY_PATH = new URL('../docs/history.json', import.meta.url);

export async function fetchJsonWithRetry(url, fetchImpl = fetch, delays = [1000, 4000, 9000]) {
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < delays.length) await new Promise(r => setTimeout(r, delays[attempt]));
    }
  }
  throw lastErr;
}

// Open-Meteo 帶 timezone 參數時回傳 "2026-08-05T05:24" 格式的當地時間，固定補 +08:00
const toEpoch = iso => new Date(`${iso}:00+08:00`).getTime();

// ---- 光路取樣：低雲阻擋改用「沿太陽方位角延伸 300km 的真實光路」 ----

export const PATH_DISTANCES = [40, 90, 150, 220, 300]; // km，沿事件時刻太陽方位角方向
export const PATH_WEIGHTS = [0.30, 0.25, 0.20, 0.15, 0.10]; // 越近觀測者光束越低、遮蔽效應越強
const PATH_BLEND = 0.6; // 有效低雲 = 0.6*光路加權 + 0.4*市中心

export function weightedPathLow(lows) {
  if (lows.length !== PATH_WEIGHTS.length) {
    throw new Error(`weightedPathLow: 需要 ${PATH_WEIGHTS.length} 個光路點，實得 ${lows.length}`);
  }
  return lows.reduce((sum, low, i) => sum + low * PATH_WEIGHTS[i], 0);
}

export function effectiveLow(pathLow, centerLow) {
  return PATH_BLEND * pathLow + (1 - PATH_BLEND) * centerLow;
}

// 事件時刻的太陽方位角 + 沿線取樣點（日落往西進台灣海峽、日出往東出太平洋，隨季節擺動）
export function buildPathPoints(eventIso) {
  const azimuth = sunAzimuthAt(toEpoch(eventIso), LAT, LON);
  return { azimuth, points: PATH_DISTANCES.map(km => ({ km, ...destinationPoint(LAT, LON, azimuth, km) })) };
}

// Open-Meteo 多點批次回應：單點回物件、多點回陣列；點數不符視為整次失敗
export function parsePathBatch(payload, expectedCount) {
  const arr = Array.isArray(payload) ? payload : [payload];
  if (arr.length !== expectedCount) {
    throw new Error(`parsePathBatch: 批次回應 ${arr.length} 點，應為 ${expectedCount} 點`);
  }
  return arr;
}

function pathBatchUrl(points) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${points.map(p => p.lat.toFixed(4)).join(',')}`
    + `&longitude=${points.map(p => p.lon.toFixed(4)).join(',')}`
    + `&hourly=cloud_cover_low&timezone=Asia%2FTaipei&forecast_days=5`;
}

// 評分需要的七個欄位，順序即驗證順序
const REQUIRED_FIELDS = ['cloudLow', 'cloudMid', 'cloudHigh', 'humidity', 'visibility', 'aod', 'precipProb'];

// 取單一序列在事件時刻的插值；序列缺漏時把欄位名帶進錯誤訊息，方便一眼看出是哪個變數壞了。
function pick(field, times, values, epoch) {
  try {
    return interpolate(times, values, epoch);
  } catch (err) {
    throw new Error(`conditionsAt: ${field} 取值失敗（${err.message}）`, { cause: err });
  }
}

export function conditionsAt(forecast, air, epoch) {
  const wt = forecast.hourly.time.map(toEpoch);
  const at = air.hourly.time.map(toEpoch);
  const w = (field, key) => pick(field, wt, forecast.hourly[key], epoch);
  const cond = {
    cloudLow: w('cloudLow', 'cloud_cover_low'),
    cloudMid: w('cloudMid', 'cloud_cover_mid'),
    cloudHigh: w('cloudHigh', 'cloud_cover_high'),
    humidity: w('humidity', 'relative_humidity_2m'),
    visibility: w('visibility', 'visibility'),
    precipProb: w('precipProb', 'precipitation_probability'),
    aod: pick('aod', at, air.hourly.aerosol_optical_depth, epoch),
  };
  // 大聲失敗：Open-Meteo 的 AOD 與能見度實務上可能整段缺值，
  // 寧可整次執行以非零碼結束，也不讓 NaN 流進評分或讓缺值靜默扣分。
  for (const field of REQUIRED_FIELDS) {
    if (!Number.isFinite(cond[field])) {
      throw new Error(`conditionsAt: ${field} 非有限數值（取得 ${cond[field]}）`);
    }
  }
  return cond;
}

// paths[kind] = { azimuth, samples: [5 個 Open-Meteo 單點回應] }
function evaluate(forecast, air, paths, kind, iso) {
  const epoch = toEpoch(iso);
  const cond = conditionsAt(forecast, air, epoch);
  const p = paths[kind];
  const lows = p.samples.map((s, i) =>
    pick(`光路點${i + 1} cloudLow`, s.hourly.time.map(toEpoch), s.hourly.cloud_cover_low, epoch));
  lows.forEach((low, i) => {
    if (!Number.isFinite(low)) throw new Error(`evaluate: 光路點${i + 1} 低雲非有限數值（取得 ${low}）`);
  });
  const pathLow = weightedPathLow(lows);
  const centerLow = cond.cloudLow;
  cond.cloudLow = effectiveLow(pathLow, centerLow);
  return {
    eventTime: `${iso}:00+08:00`,
    ...scoreEvent(cond),
    lightPath: {
      azimuth: Math.round(p.azimuth),
      pathLow: Math.round(pathLow),
      centerLow: Math.round(centerLow),
      points: PATH_DISTANCES.map((km, i) => ({ km, low: Math.round(lows[i]) })),
    },
  };
}

export function nextEvents(forecast, now) {
  const events = forecast.daily.time.flatMap((_, i) => [
    { kind: 'sunrise', iso: forecast.daily.sunrise[i] },
    { kind: 'sunset', iso: forecast.daily.sunset[i] },
  ]).map(e => ({ ...e, epoch: toEpoch(e.iso) }))
    .filter(e => e.epoch > now)
    .sort((a, b) => a.epoch - b.epoch);

  const nextSunrise = events.find(e => e.kind === 'sunrise');
  const nextSunset = events.find(e => e.kind === 'sunset');
  if (!nextSunrise || !nextSunset) {
    throw new Error('nextEvents: 預報範圍內找不到下一場日出或日落，資料可能過期');
  }
  return { nextSunrise, nextSunset };
}

export function buildData(forecast, air, paths, trigger, now) {
  const { nextSunrise, nextSunset } = nextEvents(forecast, now);

  // 趨勢：接下來 3 天（光路點沿用下一場事件的取樣，逐日方位角差 <2°，300km 尺度可忽略）
  const firstEpoch = Math.min(nextSunrise.epoch, nextSunset.epoch);
  const outlook = forecast.daily.time
    .map((date, i) => ({ date, sunriseIso: forecast.daily.sunrise[i], sunsetIso: forecast.daily.sunset[i] }))
    .filter(d => toEpoch(d.sunriseIso) > firstEpoch || toEpoch(d.sunsetIso) > firstEpoch)
    .slice(0, 3)
    .map(d => ({
      date: d.date,
      sunrise: { time: `${d.sunriseIso}:00+08:00`, score: evaluate(forecast, air, paths, 'sunrise', d.sunriseIso).score },
      sunset: { time: `${d.sunsetIso}:00+08:00`, score: evaluate(forecast, air, paths, 'sunset', d.sunsetIso).score },
    }));

  return {
    generatedAt: new Date(now).toISOString(),
    trigger,
    next: {
      sunrise: evaluate(forecast, air, paths, 'sunrise', nextSunrise.iso),
      sunset: evaluate(forecast, air, paths, 'sunset', nextSunset.iso),
    },
    outlook,
  };
}

// factors 陣列 → { canvas: 34, lowCloud: 20, ... }，存進 history 供日後權重校準
export function factorScores(factors) {
  return Object.fromEntries(factors.map(f => [f.key, f.score]));
}

// 只有「檔案不存在」算首次執行；壞檔、權限錯誤等一律往外拋，
// 否則一次 JSON.parse 失敗就會讓整份歷史被一筆新資料靜默覆蓋掉。
export async function readHistory(path = HISTORY_PATH) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const history = JSON.parse(raw);
  if (!Array.isArray(history)) {
    throw new Error(`readHistory: ${path} 內容不是陣列，拒絕覆寫既有歷史`);
  }
  return history;
}

async function main() {
  const trigger = process.argv[2] || 'manual';
  const [forecast, air] = await Promise.all([
    fetchJsonWithRetry(FORECAST_URL),
    fetchJsonWithRetry(AIR_URL),
  ]);

  const now = Date.now();
  const { nextSunrise, nextSunset } = nextEvents(forecast, now);
  const sunsetPath = buildPathPoints(nextSunset.iso);
  const sunrisePath = buildPathPoints(nextSunrise.iso);
  const allPoints = [...sunsetPath.points, ...sunrisePath.points];
  const batch = parsePathBatch(await fetchJsonWithRetry(pathBatchUrl(allPoints)), allPoints.length);
  const paths = {
    sunset: { azimuth: sunsetPath.azimuth, samples: batch.slice(0, PATH_DISTANCES.length) },
    sunrise: { azimuth: sunrisePath.azimuth, samples: batch.slice(PATH_DISTANCES.length) },
  };

  const data = buildData(forecast, air, paths, trigger, now);
  // 先把歷史讀進來再落筆：任何一份資料有問題，就兩份都不寫。
  const history = await readHistory();

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
  history.push({
    ranAt: data.generatedAt,
    trigger,
    sunriseScore: data.next.sunrise.score,
    sunsetScore: data.next.sunset.score,
    sunriseTime: data.next.sunrise.eventTime,
    sunsetTime: data.next.sunset.eventTime,
    sunriseFactors: factorScores(data.next.sunrise.factors),
    sunsetFactors: factorScores(data.next.sunset.factors),
  });
  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
  console.log(`OK trigger=${trigger} sunrise=${data.next.sunrise.score} sunset=${data.next.sunset.score}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exitCode = 1; });
}
