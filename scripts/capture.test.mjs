import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camMetrics, CAMERAS, SKY_FRACTION } from './capture.mjs';
import { findTodayPrediction, upsertVerification, taipeiToday, readJsonArray } from './verification.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 產生 w×h 的 RGB 影格：上半 skyColor、下半 groundColor
function frame(w, h, skyColor, groundColor) {
  const buf = Buffer.alloc(w * h * 3);
  const skyRows = Math.round(h * SKY_FRACTION);
  for (let y = 0; y < h; y++) {
    const [r, g, b] = y < skyRows ? skyColor : groundColor;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
  }
  return buf;
}

test('camMetrics：藍天 → camBurnIndex 0', () => {
  const m = camMetrics(frame(20, 20, [120, 160, 220], [80, 80, 80]), 20, 20);
  assert.equal(m.camWarmRatio, 0);
  assert.equal(m.camBurnIndex, 0);
});

test('camMetrics：整片火燒天 → camBurnIndex 100（暖色 40% 面積即封頂）', () => {
  const m = camMetrics(frame(20, 20, [230, 110, 70], [40, 40, 40]), 20, 20);
  assert.equal(m.camWarmRatio, 1);
  assert.equal(m.camBurnIndex, 100);
});

test('camMetrics：天空 40% 面積轉暖 → camBurnIndex 100 剛好封頂', () => {
  const w = 10, h = 20, buf = Buffer.alloc(w * h * 3);
  const skyRows = Math.round(h * SKY_FRACTION);
  for (let y = 0; y < skyRows; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const warm = x < w * 0.4;
      buf[i] = warm ? 230 : 120; buf[i + 1] = warm ? 110 : 160; buf[i + 2] = warm ? 70 : 220;
    }
  }
  const m = camMetrics(buf, w, h);
  assert.equal(m.camWarmRatio, 0.4);
  assert.equal(m.camBurnIndex, 100);
});

test('camMetrics：天空 20% 面積轉暖 → camBurnIndex 50', () => {
  const w = 10, h = 20, buf = Buffer.alloc(w * h * 3);
  const skyRows = Math.round(h * SKY_FRACTION);
  for (let y = 0; y < skyRows; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const warm = x < w * 0.2;
      buf[i] = warm ? 230 : 120; buf[i + 1] = warm ? 110 : 160; buf[i + 2] = warm ? 70 : 220;
    }
  }
  assert.equal(camMetrics(buf, w, h).camBurnIndex, 50);
});

test('camMetrics：只看天空區域，地面的暖色磚牆不計入', () => {
  const m = camMetrics(frame(20, 20, [120, 160, 220], [230, 110, 70]), 20, 20);
  assert.equal(m.camWarmRatio, 0, '地面暖色不應被算進來');
});

test('camMetrics：夜空（暗紅街燈色）亮度不足不算暖', () => {
  const m = camMetrics(frame(20, 20, [60, 20, 15], [10, 10, 10]), 20, 20);
  assert.equal(m.camWarmRatio, 0);
  assert.equal(m.camBrightRatio, 0);
});

test('camMetrics：位元組數不足時拋錯（ffmpeg 抓幀不完整）', () => {
  assert.throws(() => camMetrics(Buffer.alloc(100), 20, 20), /影格位元組不足/);
});

test('CAMERAS 兩場都有影片 id 與名稱', () => {
  for (const kind of ['sunset', 'sunrise']) {
    assert.match(CAMERAS[kind].id, /^[\w-]{11}$/);
    assert.ok(CAMERAS[kind].name.length > 0);
  }
});

// ---- verification.mjs 共用邏輯 ----

const HISTORY = [
  { sunsetTime: '2026-08-05T18:36:00+08:00', sunsetScore: 46, sunriseTime: '2026-08-06T05:23:00+08:00', sunriseScore: 44 },
  { sunsetTime: '2026-08-06T18:35:00+08:00', sunsetScore: 50, sunriseTime: '2026-08-07T05:24:00+08:00', sunriseScore: 18,
    sunsetFactors: { canvas: 20, lowCloud: 20, clarity: 0, aerosol: 10, rain: 0 } },
];

test('findTodayPrediction 取當天最新一筆，並帶出 factors', () => {
  const got = findTodayPrediction(HISTORY, 'sunset', '2026-08-06');
  assert.equal(got.predictedScore, 50);
  assert.equal(got.factors.canvas, 20);
  assert.equal(findTodayPrediction(HISTORY, 'sunrise', '2026-08-06').predictedScore, 44);
  assert.equal(findTodayPrediction(HISTORY, 'sunrise', '2026-08-06').factors, null, '舊紀錄無 factors 時回 null');
});

test('findTodayPrediction 找不到當天資料回 null', () => {
  assert.equal(findTodayPrediction(HISTORY, 'sunset', '2026-08-09'), null);
});

test('upsertVerification：同 (date,kind) 合併欄位，不覆蓋既有欄位', () => {
  const records = [{ date: '2026-08-06', kind: 'sunset', predictedScore: 50 }];
  upsertVerification(records, { date: '2026-08-06', kind: 'sunset', camBurnIndex: 70 });
  assert.equal(records.length, 1);
  assert.equal(records[0].predictedScore, 50);
  assert.equal(records[0].camBurnIndex, 70);
  upsertVerification(records, { date: '2026-08-06', kind: 'sunrise', camBurnIndex: 5 });
  assert.equal(records.length, 2);
});

test('taipeiToday 以台北時區換日', () => {
  assert.equal(taipeiToday(Date.parse('2026-08-06T16:30:00Z')), '2026-08-07');
  assert.equal(taipeiToday(Date.parse('2026-08-06T15:30:00Z')), '2026-08-06');
});

test('readJsonArray：檔案不存在回空陣列、壞檔拋錯', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'burning-sky-cap-'));
  try {
    assert.deepEqual(await readJsonArray(join(dir, 'nope.json')), []);
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '[{"date":');
    await assert.rejects(() => readJsonArray(bad));
    const notArray = join(dir, 'obj.json');
    await writeFile(notArray, '{"date":"x"}');
    await assert.rejects(() => readJsonArray(notArray), /不是陣列/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
