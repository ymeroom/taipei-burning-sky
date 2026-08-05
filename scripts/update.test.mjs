import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchJsonWithRetry, conditionsAt, buildData, readHistory } from './update.mjs';

const ok = data => ({ ok: true, json: async () => data });
const fail = status => ({ ok: false, status });

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

test('conditionsAt 遇到非數值（字串）時拋出含欄位名的錯誤', () => {
  const forecast = makeForecast({ relative_humidity_2m: fill('高') });
  assert.throws(
    () => conditionsAt(forecast, makeAir(), epochOf('2026-08-05T18:35')),
    /conditionsAt: humidity 非有限數值/,
  );
});

test('buildData 在缺值時整批失敗，不回傳半套資料', () => {
  const air = makeAir({ aerosol_optical_depth: fill(null) });
  assert.throws(
    () => buildData(makeForecast(), air, 'manual', epochOf('2026-08-05T15:00')),
    /conditionsAt: aod/,
  );
});

test('buildData 組出下一場日出日落與 3 天趨勢', () => {
  const now = epochOf('2026-08-05T15:00');
  const data = buildData(makeForecast(), makeAir(), 'sunset-run', now);

  assert.equal(data.trigger, 'sunset-run');
  assert.equal(data.generatedAt, new Date(now).toISOString());

  // 15:00 時：下一場日落是今天傍晚，下一場日出是明天清晨
  assert.equal(data.next.sunset.eventTime, `2026-08-05T${SUNSET}:00+08:00`);
  assert.equal(data.next.sunrise.eventTime, `2026-08-06T${SUNRISE}:00+08:00`);
  for (const event of [data.next.sunset, data.next.sunrise]) {
    assert.equal(event.factors.length, 5);
    assert.ok(Number.isInteger(event.score) && event.score >= 0 && event.score <= 100);
    assert.equal(typeof event.level, 'string');
  }

  assert.equal(data.outlook.length, 3);
  assert.deepEqual(data.outlook.map(d => d.date), ['2026-08-06', '2026-08-07', '2026-08-08']);
  assert.equal(data.outlook[0].sunrise.time, `2026-08-06T${SUNRISE}:00+08:00`);
  assert.equal(data.outlook[0].sunset.time, `2026-08-06T${SUNSET}:00+08:00`);
  assert.ok(Number.isInteger(data.outlook[0].sunset.score));
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

test('readHistory 讀到非陣列的 JSON 時拋錯', async () => {
  await withTempFile('{"ranAt":"2026-08-05T16:01:34.997Z"}', async path => {
    await assert.rejects(() => readHistory(path), /readHistory: /);
  });
});

