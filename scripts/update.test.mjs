import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchJsonWithRetry, conditionsAt, buildData, readHistory,
  PATH_DISTANCES, PATH_WEIGHTS, weightedPathLow, effectiveLow, buildPathPoints, parseBatch, factorScores,
  buildPathPlan, assembleBatches, nextEventsFor, historyEntry,
} from './update.mjs';
import { LOCATIONS, locationById } from './locations.mjs';

const ok = data => ({ ok: true, json: async () => data });
// 失敗回應也給 json()：若實作漏掉 res.ok 檢查而逕自解析 body，測試才會抓得到
const fail = status => ({ ok: false, status, json: async () => ({ 不該被讀到: true }) });

test('fetchJsonWithRetry 首次成功直接回傳', async () => {
  const result = await fetchJsonWithRetry('http://x', async () => ok({ a: 1 }), [0, 0, 0]);
  assert.deepEqual(result, { a: 1 });
});

test('fetchJsonWithRetry 失敗兩次後成功（共重試 3 次內）', async () => {
  let calls = 0;
  const impl = async () => (++calls < 3 ? fail(500) : ok({ ok: true }));
  const result = await fetchJsonWithRetry('http://x', impl, [0, 0, 0]);
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
});

test('fetchJsonWithRetry 全部失敗（1+3 次）後拋錯', async () => {
  let calls = 0;
  const impl = async () => { calls++; throw new Error('網路爆炸'); };
  await assert.rejects(() => fetchJsonWithRetry('http://x', impl, [0, 0, 0]), /網路爆炸/);
  assert.equal(calls, 4);
});

test('fetchJsonWithRetry HTTP 非 2xx 視為失敗，錯誤帶狀態碼與網址', async () => {
  let calls = 0;
  const impl = async () => { calls++; return fail(500); };
  await assert.rejects(
    () => fetchJsonWithRetry('http://x', impl, [0, 0, 0]),
    err => /HTTP 500/.test(err.message) && /http:\/\/x/.test(err.message),
  );
  assert.equal(calls, 4);
});

// ---- 假資料工具：五天、每小時常數值 ----

const DAYS = ['2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];
const SUNRISE = '05:24';
const SUNSET = '18:35';

const hourlyTimes = () =>
  DAYS.flatMap(d => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));

const fill = value => hourlyTimes().map(() => value);

function makeForecast(overrides = {}) {
  return {
    hourly: {
      time: hourlyTimes(),
      cloud_cover_low: fill(10),
      cloud_cover_mid: fill(25),
      cloud_cover_high: fill(20),
      relative_humidity_2m: fill(70),
      visibility: fill(24000),
      precipitation_probability: fill(0),
      ...overrides,
    },
    daily: {
      time: DAYS,
      sunrise: DAYS.map(d => `${d}T${SUNRISE}`),
      sunset: DAYS.map(d => `${d}T${SUNSET}`),
    },
  };
}

const makeAir = (overrides = {}) => ({
  hourly: { time: hourlyTimes(), aerosol_optical_depth: fill(0.2), ...overrides },
});

const epochOf = iso => new Date(`${iso}:00+08:00`).getTime();

// ---- 光路取樣 ----

test('光路權重總和恰為 1.0', () => {
  const sum = PATH_WEIGHTS.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, `權重和 ${sum}`);
  assert.equal(PATH_WEIGHTS.length, PATH_DISTANCES.length);
});

test('weightedPathLow 加權數學：[10,20,30,40,50] → 25', () => {
  assert.ok(Math.abs(weightedPathLow([10, 20, 30, 40, 50]) - 25) < 1e-9);
});

test('weightedPathLow 點數不符拋錯', () => {
  assert.throws(() => weightedPathLow([10, 20, 30]), /weightedPathLow/);
});

test('effectiveLow(25, 13) = 0.6×25 + 0.4×13 = 20.2', () => {
  assert.ok(Math.abs(effectiveLow(25, 13) - 20.2) < 1e-9);
});

test('buildPathPoints 八月日落：方位角在西北西、取樣點一路向西', () => {
  const { azimuth, points } = buildPathPoints('2026-08-06T18:35', 25.04, 121.56);
  assert.ok(azimuth > 280 && azimuth < 295, `八月日落方位角 ${azimuth.toFixed(1)}`);
  assert.equal(points.length, 5);
  assert.deepEqual(points.map(p => p.km), PATH_DISTANCES);
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].lon < points[i - 1].lon, '經度應遞減（向西）');
  }
  assert.ok(points[4].lon < 119, `300km 點應進台灣海峽（lon=${points[4].lon.toFixed(2)}）`);
});

test('parseBatch 筆數不符拋錯（含 label）、相符原樣回傳、單點物件自動包成陣列', () => {
  assert.throws(() => parseBatch([{}, {}, {}], 5, '光路'), /parseBatch\(光路\): 批次回應 3 筆，應為 5 筆/);
  assert.equal(parseBatch([1, 2, 3], 3, '天氣').length, 3);
  assert.deepEqual(parseBatch({ a: 1 }, 1, '天氣'), [{ a: 1 }]);
});

test('factorScores 把 factors 陣列轉成 key→score 物件', () => {
  const factors = [{ key: 'canvas', score: 34 }, { key: 'rain', score: 10 }];
  assert.deepEqual(factorScores(factors), { canvas: 34, rain: 10 });
});

test('conditionsAt 正常資料回傳七個有限數值', () => {
  const cond = conditionsAt(makeForecast(), makeAir(), epochOf('2026-08-05T18:35'));
  assert.deepEqual(Object.keys(cond).sort(),
    ['aod', 'cloudHigh', 'cloudLow', 'cloudMid', 'humidity', 'precipProb', 'visibility']);
  for (const [key, value] of Object.entries(cond)) {
    assert.ok(Number.isFinite(value), `${key} 應為有限數值，實得 ${value}`);
  }
  assert.equal(cond.visibility, 24000);
  assert.equal(cond.aod, 0.2);
});

test('conditionsAt 遇到整段缺值的能見度時拋出含欄位名的錯誤', () => {
  const forecast = makeForecast({ visibility: fill(null) });
  assert.throws(
    () => conditionsAt(forecast, makeAir(), epochOf('2026-08-05T18:35')),
    /conditionsAt: visibility/,
  );
});

test('conditionsAt 遇到 API 未回傳 AOD 欄位時拋出含欄位名的錯誤', () => {
  const air = { hourly: { time: hourlyTimes() } };
  assert.throws(
    () => conditionsAt(makeForecast(), air, epochOf('2026-08-05T18:35')),
    /conditionsAt: aod/,
  );
});

// 七個欄位逐一驗證：每個都要真的被 Number.isFinite 檢查到，而不是只有其中一兩個。
const FIELD_TO_HOURLY_KEY = {
  cloudLow: 'cloud_cover_low',
  cloudMid: 'cloud_cover_mid',
  cloudHigh: 'cloud_cover_high',
  humidity: 'relative_humidity_2m',
  visibility: 'visibility',
  precipProb: 'precipitation_probability',
  aod: 'aerosol_optical_depth',
};

for (const [field, hourlyKey] of Object.entries(FIELD_TO_HOURLY_KEY)) {
  test(`conditionsAt 的 ${field} 為非數值（字串）時拋出含欄位名的錯誤`, () => {
    const corrupted = { [hourlyKey]: fill('高') };
    const forecast = field === 'aod' ? makeForecast() : makeForecast(corrupted);
    const air = field === 'aod' ? makeAir(corrupted) : makeAir();
    assert.throws(
      () => conditionsAt(forecast, air, epochOf('2026-08-05T18:35')),
      new RegExp(`conditionsAt: ${field} 非有限數值`),
    );
  });
}

// ---- 多地點：批次對位是本次最高風險處 ----

// 每個地點餵「明顯不同」的天氣，錯位就會被抓到
const LOC_CLOUD = { taipei: 40, tamsui: 0, gaomei: 100, wanggaoliao: 40 };

const makeWeatherByLoc = () => Object.fromEntries(LOCATIONS.map(l => [
  l.id,
  makeForecast({ cloud_cover_mid: fill(LOC_CLOUD[l.id]), cloud_cover_high: fill(0) }),
]));

// 依 buildPathPlan 的索引順序造出對應筆數的光路回應，每個地點的點都帶自己的低雲值
function makePathArr(plan, lowByLoc = {}) {
  const arr = new Array(plan.points.length);
  for (const [key, { start }] of plan.index) {
    const locId = key.split(':')[0];
    for (let i = 0; i < PATH_DISTANCES.length; i++) {
      arr[start + i] = { hourly: { time: hourlyTimes(), cloud_cover_low: fill(lowByLoc[locId] ?? 10) } };
    }
  }
  return arr;
}

function makeAssembled(now, lowByLoc = {}) {
  const weatherByLoc = makeWeatherByLoc();
  const plan = buildPathPlan(weatherByLoc, now);
  const weatherArr = LOCATIONS.map(l => weatherByLoc[l.id]);
  const airArr = LOCATIONS.map(() => makeAir());
  return { assembled: assembleBatches(weatherArr, airArr, makePathArr(plan, lowByLoc), plan), plan };
}

test('nextEventsFor 只回傳該地宣告的場次', () => {
  const now = epochOf('2026-08-05T15:00');
  const f = makeForecast();
  assert.deepEqual(Object.keys(nextEventsFor(f, locationById('taipei'), now)).sort(), ['sunrise', 'sunset']);
  assert.deepEqual(Object.keys(nextEventsFor(f, locationById('gaomei'), now)), ['sunset']);
  assert.deepEqual(Object.keys(nextEventsFor(f, locationById('wanggaoliao'), now)), ['sunrise']);
});

test('nextEventsFor 在預報範圍內找不到宣告場次時拋錯', () => {
  const past = makeForecast();
  const now = epochOf('2026-08-10T23:00'); // 晚於所有假資料日期
  assert.throws(() => nextEventsFor(past, locationById('gaomei'), now), /gaomei 的預報範圍內找不到下一場 sunset/);
});

test('buildPathPlan：25 個光路點，索引依 LOCATIONS 順序排列', () => {
  const now = epochOf('2026-08-05T15:00');
  const plan = buildPathPlan(makeWeatherByLoc(), now);
  assert.equal(plan.points.length, 25, '台北 2 場×5 + 其餘 3 地各 5');
  assert.equal(plan.index.get('taipei:sunset').start, 0);
  assert.equal(plan.index.get('taipei:sunrise').start, 5);
  assert.equal(plan.index.get('tamsui:sunset').start, 10);
  assert.equal(plan.index.get('gaomei:sunset').start, 15);
  assert.equal(plan.index.get('wanggaoliao:sunrise').start, 20);
  assert.equal(plan.index.size, 5);
});

test('buildPathPlan：各地方位角依自己的緯經度算，不共用台北的', () => {
  const now = epochOf('2026-08-05T15:00');
  const plan = buildPathPlan(makeWeatherByLoc(), now);
  const taipei = plan.index.get('taipei:sunset').azimuth;
  const gaomei = plan.index.get('gaomei:sunset').azimuth;
  assert.ok(Math.abs(taipei - gaomei) > 0.05, `兩地方位角不該完全相同（${taipei} vs ${gaomei}）`);
  for (const key of ['taipei:sunset', 'tamsui:sunset', 'gaomei:sunset']) {
    const az = plan.index.get(key).azimuth;
    assert.ok(az > 280 && az < 296, `${key} 八月日落方位角應在西北西，實得 ${az.toFixed(1)}`);
  }
});

test('assembleBatches：每個地點拿到自己那一筆天氣與空品', () => {
  const now = epochOf('2026-08-05T15:00');
  const weatherByLoc = makeWeatherByLoc();
  const plan = buildPathPlan(weatherByLoc, now);
  const weatherArr = LOCATIONS.map(l => weatherByLoc[l.id]);
  const airArr = LOCATIONS.map((l, i) => makeAir({ aerosol_optical_depth: fill(0.1 * (i + 1)) }));
  const a = assembleBatches(weatherArr, airArr, makePathArr(plan), plan);

  for (const l of LOCATIONS) {
    assert.equal(a.weather[l.id].hourly.cloud_cover_mid[0], LOC_CLOUD[l.id], `${l.id} 天氣對錯地點了`);
  }
  assert.ok(Math.abs(a.air.taipei.hourly.aerosol_optical_depth[0] - 0.1) < 1e-9);
  assert.ok(Math.abs(a.air.wanggaoliao.hourly.aerosol_optical_depth[0] - 0.4) < 1e-9);
  assert.equal(a.paths['gaomei:sunset'].samples.length, 5);
});

test('assembleBatches：光路切片切給對的地點（錯位就會拿到別人的低雲）', () => {
  const now = epochOf('2026-08-05T15:00');
  const weatherByLoc = makeWeatherByLoc();
  const plan = buildPathPlan(weatherByLoc, now);
  const lowByLoc = { taipei: 5, tamsui: 25, gaomei: 60, wanggaoliao: 80 };
  const a = assembleBatches(
    LOCATIONS.map(l => weatherByLoc[l.id]), LOCATIONS.map(() => makeAir()),
    makePathArr(plan, lowByLoc), plan);

  for (const [key, expected] of Object.entries({
    'taipei:sunset': 5, 'taipei:sunrise': 5, 'tamsui:sunset': 25,
    'gaomei:sunset': 60, 'wanggaoliao:sunrise': 80,
  })) {
    assert.equal(a.paths[key].samples[0].hourly.cloud_cover_low[0], expected, `${key} 光路切錯`);
  }
});

test('buildData：每個地點只產生自己宣告的場次', () => {
  const now = epochOf('2026-08-05T15:00');
  const { assembled } = makeAssembled(now);
  const data = buildData(assembled, 'sunset-run', now);

  assert.equal(data.trigger, 'sunset-run');
  assert.equal(data.generatedAt, new Date(now).toISOString());
  assert.deepEqual(data.locations.map(l => l.id), ['taipei', 'tamsui', 'gaomei', 'wanggaoliao']);

  const byId = Object.fromEntries(data.locations.map(l => [l.id, l]));
  assert.deepEqual(Object.keys(byId.taipei.events).sort(), ['sunrise', 'sunset']);
  assert.deepEqual(Object.keys(byId.tamsui.events), ['sunset']);
  assert.deepEqual(Object.keys(byId.gaomei.events), ['sunset']);
  assert.deepEqual(Object.keys(byId.wanggaoliao.events), ['sunrise']);
  assert.equal(byId.taipei.name, '台北市中心');
  assert.equal(byId.gaomei.name, '高美濕地');
});

// 這條是整個多地點改動的核心防線：分數必須跟著自己地點的天氣走
test('buildData：分數對應到各自地點的天氣，沒有錯位', () => {
  const now = epochOf('2026-08-05T15:00');
  const { assembled } = makeAssembled(now);
  const byId = Object.fromEntries(buildData(assembled, 'sunset-run', now).locations.map(l => [l.id, l]));

  const canvasOf = (id, kind) => byId[id].events[kind].factors.find(f => f.key === 'canvas');

  // 台北中高雲 40%（落在 25-60 滿分區間）
  assert.equal(canvasOf('taipei', 'sunset').score, 40);
  assert.equal(canvasOf('taipei', 'sunset').value, '中高雲合計 40%');
  // 淡水 0%（無雲可燒）
  assert.equal(canvasOf('tamsui', 'sunset').score, 0);
  assert.equal(canvasOf('tamsui', 'sunset').value, '中高雲合計 0%');
  // 高美 100%（全陰）
  assert.equal(canvasOf('gaomei', 'sunset').score, 0);
  assert.equal(canvasOf('gaomei', 'sunset').value, '中高雲合計 100%');
  // 望高寮 40%，且是日出場
  assert.equal(canvasOf('wanggaoliao', 'sunrise').score, 40);

  // 分數整體也要不同，證明不是巧合
  assert.notEqual(byId.taipei.events.sunset.score, byId.gaomei.events.sunset.score);
});

test('buildData：lightPath 綁對地點，方位角與光路低雲各自獨立', () => {
  const now = epochOf('2026-08-05T15:00');
  const { assembled } = makeAssembled(now, { taipei: 5, tamsui: 25, gaomei: 60, wanggaoliao: 80 });
  const byId = Object.fromEntries(buildData(assembled, 'sunset-run', now).locations.map(l => [l.id, l]));

  assert.equal(byId.taipei.events.sunset.lightPath.pathLow, 5);
  assert.equal(byId.tamsui.events.sunset.lightPath.pathLow, 25);
  assert.equal(byId.gaomei.events.sunset.lightPath.pathLow, 60);
  assert.equal(byId.wanggaoliao.events.sunrise.lightPath.pathLow, 80);

  for (const l of Object.values(byId)) {
    for (const ev of Object.values(l.events)) {
      assert.equal(ev.lightPath.points.length, 5);
      assert.ok(Number.isInteger(ev.lightPath.azimuth));
    }
  }
  // 光路低雲多的地點，低雲因子得分應較低
  const low = id => byId[id].events[id === 'wanggaoliao' ? 'sunrise' : 'sunset'].factors.find(f => f.key === 'lowCloud').score;
  assert.ok(low('taipei') > low('gaomei'), '台北光路較乾淨，低雲因子應高於高美');
});

test('buildData：outlook 只列該地宣告的場次，長度 3', () => {
  const now = epochOf('2026-08-05T15:00');
  const { assembled } = makeAssembled(now);
  const byId = Object.fromEntries(buildData(assembled, 'sunset-run', now).locations.map(l => [l.id, l]));

  for (const l of Object.values(byId)) assert.equal(l.outlook.length, 3, `${l.id} outlook 長度`);
  assert.deepEqual(Object.keys(byId.gaomei.outlook[0]).sort(), ['date', 'sunset']);
  assert.deepEqual(Object.keys(byId.wanggaoliao.outlook[0]).sort(), ['date', 'sunrise']);
  assert.deepEqual(Object.keys(byId.taipei.outlook[0]).sort(), ['date', 'sunrise', 'sunset']);
  assert.ok(Number.isInteger(byId.gaomei.outlook[0].sunset.score));
});

test('buildData 在缺值時整批失敗，不回傳半套資料', () => {
  const now = epochOf('2026-08-05T15:00');
  const { assembled } = makeAssembled(now);
  assembled.air.gaomei = makeAir({ aerosol_optical_depth: fill(null) });
  assert.throws(() => buildData(assembled, 'manual', now), /conditionsAt: aod/);
});

// 鎖住「事件時刻以 +08:00 解析」：19:00 已過今日日落，下一場日落必須是明天
test('buildData 在今日日落之後執行，下一場日落是明天（+08:00 解析）', () => {
  const now = epochOf('2026-08-05T19:00');
  const { assembled } = makeAssembled(now);
  const byId = Object.fromEntries(buildData(assembled, 'sunset-run', now).locations.map(l => [l.id, l]));
  assert.equal(byId.taipei.events.sunset.eventTime, `2026-08-06T${SUNSET}:00+08:00`);
  assert.equal(byId.taipei.events.sunrise.eventTime, `2026-08-06T${SUNRISE}:00+08:00`);
});

test('historyEntry：以地點為索引，只記宣告的場次與五因子', () => {
  const now = epochOf('2026-08-05T15:00');
  const { assembled } = makeAssembled(now);
  const data = buildData(assembled, 'sunset-run', now);
  const entry = historyEntry(data, 'sunset-run');

  assert.equal(entry.ranAt, data.generatedAt);
  assert.equal(entry.trigger, 'sunset-run');
  assert.deepEqual(Object.keys(entry.locations).sort(), ['gaomei', 'taipei', 'tamsui', 'wanggaoliao']);
  assert.deepEqual(Object.keys(entry.locations.gaomei).sort(), ['sunsetFactors', 'sunsetScore', 'sunsetTime']);
  assert.deepEqual(Object.keys(entry.locations.wanggaoliao).sort(), ['sunriseFactors', 'sunriseScore', 'sunriseTime']);
  assert.equal(Object.keys(entry.locations.taipei).length, 6, '台北兩場各三個欄位');
  assert.deepEqual(Object.keys(entry.locations.taipei.sunsetFactors).sort(),
    ['aerosol', 'canvas', 'clarity', 'lowCloud', 'rain']);
  assert.equal(entry.locations.taipei.sunsetScore, data.locations[0].events.sunset.score);
});

// ---- history.json 讀取：只容忍「檔案不存在」，其餘一律大聲失敗 ----

// 在暫存目錄裡跑，避免碰到 repo 內真正的 docs/history.json
async function withTempFile(contents, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'burning-sky-'));
  const path = join(dir, 'history.json');
  try {
    if (contents !== null) await writeFile(path, contents);
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('readHistory 檔案不存在時視為首次執行，回傳空陣列', async () => {
  await withTempFile(null, async path => {
    assert.deepEqual(await readHistory(path), []);
  });
});

test('readHistory 讀到既有紀錄時原樣回傳', async () => {
  const existing = [{ ranAt: '2026-08-05T16:01:34.997Z', trigger: 'manual', sunriseScore: 44 }];
  await withTempFile(JSON.stringify(existing), async path => {
    assert.deepEqual(await readHistory(path), existing);
  });
});

test('readHistory 遇到壞掉的 JSON 時拋錯，不靜默清空歷史', async () => {
  await withTempFile('[{"ranAt": "2026-08', async path => {
    await assert.rejects(() => readHistory(path), err =>
      err instanceof Error && !(err.code === 'ENOENT'));
  });
});

// 把目錄本身當檔案讀 → EISDIR（Windows 與 Linux 皆同），鎖住「只吞 ENOENT」這條約束
test('readHistory 遇到非 ENOENT 的讀檔錯誤時往外拋', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'burning-sky-'));
  try {
    await assert.rejects(() => readHistory(dir), err => err.code === 'EISDIR');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readHistory 讀到非陣列的 JSON 時拋錯', async () => {
  await withTempFile('{"ranAt":"2026-08-05T16:01:34.997Z"}', async path => {
    await assert.rejects(() => readHistory(path), /readHistory: /);
  });
});

