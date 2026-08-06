import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunAzimuthAt, destinationPoint } from './geo.mjs';

const TPE = { lat: 25.04, lon: 121.56 };
const az = iso => sunAzimuthAt(Date.parse(iso), TPE.lat, TPE.lon);
const close = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: got ${actual.toFixed(2)}, want ${expected}±${tol}`);

// 錨點以球面天文推導：日落時 cos(Az₀) = sin δ / cos φ，Az = 360 − Az₀；日出 Az = Az₀
test('台北春分日落方位角 ≈ 270°', () => close(az('2026-03-20T18:11:00+08:00'), 270, 1.5, '春分日落'));
test('台北夏至日落方位角 ≈ 296°', () => close(az('2026-06-21T18:47:00+08:00'), 296, 1.5, '夏至日落'));
test('台北冬至日落方位角 ≈ 244°', () => close(az('2025-12-21T17:07:00+08:00'), 244, 1.5, '冬至日落'));
test('台北夏至日出方位角 ≈ 64°', () => close(az('2026-06-21T05:05:00+08:00'), 64, 1.5, '夏至日出'));
test('台北冬至日出方位角 ≈ 116°', () => close(az('2025-12-21T06:34:00+08:00'), 116, 1.5, '冬至日出'));

test('相鄰兩日日落方位角連續（差 < 1°）', () => {
  const a = az('2026-08-06T18:35:00+08:00');
  const b = az('2026-08-07T18:34:00+08:00');
  assert.ok(Math.abs(a - b) < 1, `8/6=${a.toFixed(2)} vs 8/7=${b.toFixed(2)}`);
});

test('destinationPoint 向西 300km', () => {
  const p = destinationPoint(TPE.lat, TPE.lon, 270, 300);
  close(p.lon, 118.581, 0.03, '經度');
  close(p.lat, 25.01, 0.15, '緯度');
});

test('destinationPoint 向北 111.195km ≈ +1° 緯度', () => {
  const p = destinationPoint(TPE.lat, TPE.lon, 0, 111.195);
  close(p.lat, 26.04, 0.01, '緯度');
  close(p.lon, TPE.lon, 0.01, '經度不變');
});
