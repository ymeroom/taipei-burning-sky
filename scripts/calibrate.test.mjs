import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  joinSamples, standardize, logisticRegression, suggestWeights, report, countSuspect,
  FACTOR_KEYS, BURN_THRESHOLD, MIN_SAMPLES,
} from './calibrate.mjs';

test('joinSamples 以 (date,kind) 配對，標籤由 camBurnIndex 門檻決定', () => {
  const history = [
    { sunsetTime: '2026-08-06T18:35:00+08:00', sunsetFactors: { canvas: 30, lowCloud: 20, clarity: 10, aerosol: 10, rain: 10 } },
    { sunriseTime: '2026-08-07T05:24:00+08:00', sunriseFactors: { canvas: 5, lowCloud: 5, clarity: 0, aerosol: 10, rain: 10 } },
  ];
  const verifications = [
    { date: '2026-08-06', kind: 'sunset', camBurnIndex: 70 },
    { date: '2026-08-07', kind: 'sunrise', camBurnIndex: 10 },
  ];
  const samples = joinSamples(history, verifications);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].y, 1, `camBurnIndex 70 ≥ ${BURN_THRESHOLD} 應為正標籤`);
  assert.equal(samples[1].y, 0);
  assert.deepEqual(samples[0].x, [30, 20, 10, 10, 10]);
});

test('joinSamples 略過無 factors 的舊紀錄與未驗證場次', () => {
  const history = [{ sunsetTime: '2026-08-06T18:35:00+08:00', sunsetScore: 50 }]; // 無 factors
  assert.equal(joinSamples(history, [{ date: '2026-08-06', kind: 'sunset', camBurnIndex: 70 }]).length, 0);
  // 有 factors 但只有衛星欄位、沒有 camBurnIndex
  const withFactors = [{ sunsetTime: '2026-08-06T18:35:00+08:00', sunsetFactors: { canvas: 1, lowCloud: 1, clarity: 1, aerosol: 1, rain: 1 } }];
  assert.equal(joinSamples(withFactors, [{ date: '2026-08-06', kind: 'sunset', satCanvasScore: 40 }]).length, 0);
});

test('joinSamples 排除標記為可疑的量測', () => {
  const history = [
    { sunriseTime: '2026-08-09T05:25:00+08:00', sunriseFactors: { canvas: 0, lowCloud: 6, clarity: 0, aerosol: 10, rain: 0 } },
    { sunsetTime: '2026-08-07T18:35:00+08:00', sunsetFactors: { canvas: 20, lowCloud: 21, clarity: 11, aerosol: 10, rain: 9 } },
  ];
  const verifications = [
    // 2026-08-09 實例：預報 16 分卻量到 burnIndex 100，人眼確認沒霞光
    { date: '2026-08-09', kind: 'sunrise', camBurnIndex: 100, suspect: true },
    { date: '2026-08-07', kind: 'sunset', camBurnIndex: 43 },
  ];
  const samples = joinSamples(history, verifications);
  assert.equal(samples.length, 1, '可疑那筆不該進樣本');
  assert.equal(samples[0].kind, 'sunset');
});

test('countSuspect 計算被排除的筆數', () => {
  assert.equal(countSuspect([{ suspect: true }, {}, { suspect: true }, { suspect: false }]), 2);
  assert.equal(countSuspect([]), 0);
});

test('report 會說明排除了幾筆可疑資料', () => {
  const samples = Array.from({ length: 60 }, (_, i) => ({
    x: [i % 2 ? 35 : 5, (i * 7) % 20, 10, 10, 10], y: i % 2 ? 1 : 0,
  }));
  assert.match(report(samples, 3), /另有 3 筆標記為可疑，已排除/);
  assert.doesNotMatch(report(samples, 0), /可疑/);
});

test('standardize：平均為 0、標準差為 1；常數欄位歸零不產生 NaN', () => {
  const { scaled } = standardize([[1, 5], [3, 5], [5, 5]]);
  const col0 = scaled.map(r => r[0]);
  assert.ok(Math.abs(col0.reduce((a, b) => a + b, 0)) < 1e-9);
  assert.ok(Math.abs(col0[2] - 1.2247) < 1e-3);
  for (const r of scaled) assert.equal(r[1], 0, '常數欄位應為 0');
});

test('logisticRegression 能還原已知關係：第一欄決定標籤 → 係數為正且最大', () => {
  const rows = [], labels = [];
  for (let i = 0; i < 60; i++) {
    const driver = i % 2 === 0 ? 35 : 5;      // 主導因子
    const noise = (i * 7) % 20;               // 無關雜訊
    rows.push([driver, noise, 10, 10, 10]);
    labels.push(driver > 20 ? 1 : 0);
  }
  const { scaled } = standardize(rows);
  const { coefficients } = logisticRegression(scaled, labels);
  assert.ok(coefficients[0] > 0, `主導因子係數應為正，實得 ${coefficients[0]}`);
  assert.ok(coefficients[0] > Math.abs(coefficients[1]), '主導因子應大於雜訊欄');
  for (const j of [2, 3, 4]) assert.equal(coefficients[j], 0, '常數欄係數應為 0');
});

test('suggestWeights：正係數按比例分配 100，負係數視為 0', () => {
  const w = suggestWeights([2, 1, -0.5, 0.5, 0.5]);
  assert.equal(w.reduce((a, b) => a + b, 0), 100);
  assert.equal(w[2], 0, '負係數應給 0');
  assert.ok(w[0] > w[1] && w[1] > w[3]);
});

test('suggestWeights：全負係數回全 0，不除以零', () => {
  assert.deepEqual(suggestWeights([-1, -2, -3, -4, -5]), FACTOR_KEYS.map(() => 0));
});

test('report：標籤全同時說明無法迴歸', () => {
  const samples = Array.from({ length: 5 }, () => ({ x: [10, 10, 10, 10, 10], y: 0 }));
  assert.match(report(samples), /標籤全部相同/);
});

test('report：正常樣本輸出含各因子與提醒人工確認', () => {
  const samples = Array.from({ length: 60 }, (_, i) => ({
    x: [i % 2 ? 35 : 5, (i * 7) % 20, 10, 10, 10],
    y: i % 2 ? 1 : 0,
  }));
  const text = report(samples);
  for (const key of FACTOR_KEYS) assert.match(text, new RegExp(key));
  assert.match(text, /建議不是決定/);
  assert.match(text, /此因子分數從未變動/, '常數欄位應被標註');
});

test('MIN_SAMPLES 門檻為 40', () => assert.equal(MIN_SAMPLES, 40));
