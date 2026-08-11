// 抓 Open-Meteo 天氣 + 空品 + 光路批次 → 算下一場日出/日落火燒雲分數 → 寫 docs/data.json、append docs/history.json
// 用法：node scripts/update.mjs [trigger]   trigger ∈ sunset-run | sunrise-run | manual
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { scoreEvent, interpolate } from './score.mjs';
import { sunAzimuthAt, destinationPoint } from './geo.mjs';
import { LOCATIONS } from './locations.mjs';

// Open-Meteo 支援逗號分隔的多點批次，實測 40 點單次呼叫沒問題，
// 所以不管幾個地點，API 呼叫數都維持 3 次（天氣、空品、光路）。
const latList = pts => pts.map(p => (p.lat ?? p.latitude).toFixed(4)).join(',');
const lonList = pts => pts.map(p => (p.lon ?? p.longitude).toFixed(4)).join(',');

const forecastUrlFor = pts => `https://api.open-meteo.com/v1/forecast?latitude=${latList(pts)}&longitude=${lonList(pts)}`
  + `&hourly=cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,visibility,precipitation_probability`
  + `&daily=sunrise,sunset&timezone=Asia%2FTaipei&forecast_days=5`;
const airUrlFor = pts => `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latList(pts)}&longitude=${lonList(pts)}`
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
export function buildPathPoints(eventIso, lat, lon) {
  const azimuth = sunAzimuthAt(toEpoch(eventIso), lat, lon);
  return { azimuth, points: PATH_DISTANCES.map(km => ({ km, ...destinationPoint(lat, lon, azimuth, km) })) };
}

// Open-Meteo 多點批次回應：單點回物件、多點回陣列；點數不符視為整次失敗。
// 這道檢查是錯位防護的第一關——少一筆就會讓後面所有地點的資料整體位移。
export function parseBatch(payload, expectedCount, label) {
  const arr = Array.isArray(payload) ? payload : [payload];
  if (arr.length !== expectedCount) {
    throw new Error(`parseBatch(${label}): 批次回應 ${arr.length} 筆，應為 ${expectedCount} 筆`);
  }
  return arr;
}

function pathBatchUrl(points) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${latList(points)}&longitude=${lonList(points)}`
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

// path = { azimuth, samples: [5 個 Open-Meteo 單點回應] }
function evaluate(forecast, air, p, iso) {
  const epoch = toEpoch(iso);
  const cond = conditionsAt(forecast, air, epoch);
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

// 只找該地點宣告的場次；宣告了卻在預報範圍內找不到，就是資料過期，整次失敗。
export function nextEventsFor(forecast, loc, now) {
  const out = {};
  for (const kind of Object.keys(loc.events)) {
    const next = forecast.daily.time
      .map((_, i) => forecast.daily[kind][i])
      .map(iso => ({ iso, epoch: toEpoch(iso) }))
      .filter(e => e.epoch > now)
      .sort((a, b) => a.epoch - b.epoch)[0];
    if (!next) throw new Error(`nextEventsFor: ${loc.id} 的預報範圍內找不到下一場 ${kind}，資料可能過期`);
    out[kind] = next;
  }
  return out;
}

// 規劃光路批次：所有地點所有宣告場次的取樣點串成一個陣列，
// 同時建立「地點:場次 → 起始索引」的顯式對照表。
// 不靠隱含順序推算，是因為錯位不會拋錯，只會安靜地把某地的天氣算成另一地的分數。
export function buildPathPlan(weatherByLoc, now, locations = LOCATIONS) {
  const points = [];
  const index = new Map();
  for (const loc of locations) {
    const events = nextEventsFor(weatherByLoc[loc.id], loc, now);
    for (const kind of Object.keys(loc.events)) {
      const { iso } = events[kind];
      const { azimuth, points: pts } = buildPathPoints(iso, loc.lat, loc.lon);
      index.set(`${loc.id}:${kind}`, { start: points.length, azimuth, iso });
      points.push(...pts);
    }
  }
  return { points, index };
}

// 三個批次回應在此處、且僅在此處對位回地點。集中一處才測得住。
export function assembleBatches(weatherArr, airArr, pathArr, plan, locations = LOCATIONS) {
  const weather = {}, air = {};
  locations.forEach((loc, i) => {
    weather[loc.id] = weatherArr[i];
    air[loc.id] = airArr[i];
  });
  const paths = {};
  for (const [key, { start, azimuth, iso }] of plan.index) {
    paths[key] = { azimuth, iso, samples: pathArr.slice(start, start + PATH_DISTANCES.length) };
  }
  return { weather, air, paths };
}

export function buildData({ weather, air, paths }, trigger, now, locations = LOCATIONS) {
  const built = locations.map(loc => {
    const forecast = weather[loc.id];
    const airData = air[loc.id];
    const kinds = Object.keys(loc.events);

    const events = {};
    for (const kind of kinds) {
      const p = paths[`${loc.id}:${kind}`];
      events[kind] = evaluate(forecast, airData, p, p.iso);
    }

    // 趨勢：接下來 3 天（光路點沿用下一場事件的取樣，逐日方位角差 <2°，300km 尺度可忽略）
    const firstEpoch = Math.min(...kinds.map(k => toEpoch(paths[`${loc.id}:${k}`].iso)));
    const outlook = forecast.daily.time
      .map((date, i) => ({ date, i }))
      .filter(({ i }) => kinds.some(k => toEpoch(forecast.daily[k][i]) > firstEpoch))
      .slice(0, 3)
      .map(({ date, i }) => {
        const row = { date };
        for (const kind of kinds) {
          const iso = forecast.daily[kind][i];
          row[kind] = { time: `${iso}:00+08:00`, score: evaluate(forecast, airData, paths[`${loc.id}:${kind}`], iso).score };
        }
        return row;
      });

    return { id: loc.id, name: loc.name, events, outlook };
  });

  return { generatedAt: new Date(now).toISOString(), trigger, locations: built };
}

// data.json → history 一筆：只記該地宣告的場次，供日後權重校準
export function historyEntry(data, trigger) {
  const locations = {};
  for (const loc of data.locations) {
    const entry = {};
    for (const [kind, ev] of Object.entries(loc.events)) {
      entry[`${kind}Score`] = ev.score;
      entry[`${kind}Time`] = ev.eventTime;
      entry[`${kind}Factors`] = factorScores(ev.factors);
    }
    locations[loc.id] = entry;
  }
  return { ranAt: data.generatedAt, trigger, locations };
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
  const now = Date.now();

  // 第一批：所有地點的天氣與空品，各一次呼叫
  const [weatherRaw, airRaw] = await Promise.all([
    fetchJsonWithRetry(forecastUrlFor(LOCATIONS)),
    fetchJsonWithRetry(airUrlFor(LOCATIONS)),
  ]);
  const weatherArr = parseBatch(weatherRaw, LOCATIONS.length, '天氣');
  const airArr = parseBatch(airRaw, LOCATIONS.length, '空品');

  // 光路取樣點取決於各地事件時刻，所以要等天氣回來才能規劃
  const weatherByLoc = Object.fromEntries(LOCATIONS.map((loc, i) => [loc.id, weatherArr[i]]));
  const plan = buildPathPlan(weatherByLoc, now);
  const pathArr = parseBatch(await fetchJsonWithRetry(pathBatchUrl(plan.points)), plan.points.length, '光路');

  const data = buildData(assembleBatches(weatherArr, airArr, pathArr, plan), trigger, now);
  // 先把歷史讀進來再落筆：任何一份資料有問題，就兩份都不寫。
  const history = await readHistory();

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
  history.push(historyEntry(data, trigger));
  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');

  const summary = data.locations
    .map(l => `${l.id}=${Object.entries(l.events).map(([k, e]) => `${k[3]}${e.score}`).join('/')}`)
    .join(' ');
  console.log(`OK trigger=${trigger} ${summary}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exitCode = 1; });
}
