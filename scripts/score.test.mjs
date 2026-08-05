import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEvent, levelFor, WEIGHTS, interpolate } from './score.mjs';

const IDEAL = { cloudLow: 0, cloudMid: 20, cloudHigh: 25, humidity: 50, visibility: 25000, aod: 0.15, precipProb: 0 };

test('權重總和為 100', () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test('理想火燒雲情境拿滿分 100', () => {
  const r = scoreEvent(IDEAL);
  assert.equal(r.score, 100);
  assert.equal(r.level, '大燒預警');
  assert.equal(r.factors.length, 5);
});

test('萬里無雲 → 畫布 0 分', () => {
  const r = scoreEvent({ ...IDEAL, cloudMid: 0, cloudHigh: 0 });
  const canvas = r.factors.find(f => f.key === 'canvas');
  assert.equal(canvas.score, 0);
  assert.equal(r.score, 60);
});

test('全陰天（中高雲 ≥95%）→ 畫布 0 分', () => {
  const r = scoreEvent({ ...IDEAL, cloudMid: 60, cloudHigh: 40 });
  assert.equal(r.factors.find(f => f.key === 'canvas').score, 0);
});

test('中高雲合成量以 100 為上限（60+70 視為 100）', () => {
  const a = scoreEvent({ ...IDEAL, cloudMid: 60, cloudHigh: 70 }).factors.find(f => f.key === 'canvas');
  const b = scoreEvent({ ...IDEAL, cloudMid: 50, cloudHigh: 50 }).factors.find(f => f.key === 'canvas');
  // 分數兩邊都落在 ≥95→0 分支，無鑑別力；顯示值才看得出有沒有 cap（沒 cap 會是 130%）
  assert.equal(a.value, '中高雲合計 100%');
  assert.equal(b.value, '中高雲合計 100%');
  assert.equal(a.score, b.score);
});

test('低雲滿天（≥70%）→ 低雲因子 0 分', () => {
  const r = scoreEvent({ ...IDEAL, cloudLow: 85 });
  assert.equal(r.factors.find(f => f.key === 'lowCloud').score, 0);
});

test('低雲 35% → 低雲因子拿一半（13 分，四捨五入）', () => {
  const r = scoreEvent({ ...IDEAL, cloudLow: 35 });
  assert.equal(r.factors.find(f => f.key === 'lowCloud').score, 13);
});

test('又濕又霧（濕度 95%、能見度 5km）→ 通透度 0 分', () => {
  const r = scoreEvent({ ...IDEAL, humidity: 95, visibility: 5000 });
  assert.equal(r.factors.find(f => f.key === 'clarity').score, 0);
});

test('濕度低但能見度差 → 通透度仍低（取兩者較差）', () => {
  const r = scoreEvent({ ...IDEAL, humidity: 40, visibility: 5000 });
  assert.equal(r.factors.find(f => f.key === 'clarity').score, 0);
});

test('AOD 0.7 以上 → 氣溶膠 0 分；極低 AOD 微扣', () => {
  assert.equal(scoreEvent({ ...IDEAL, aod: 0.9 }).factors.find(f => f.key === 'aerosol').score, 0);
  const low = scoreEvent({ ...IDEAL, aod: 0.01 }).factors.find(f => f.key === 'aerosol').score;
  assert.ok(low >= 7 && low < 10);
});

test('降雨機率 80% 以上 → 降雨因子 0 分', () => {
  assert.equal(scoreEvent({ ...IDEAL, precipProb: 90 }).factors.find(f => f.key === 'rain').score, 0);
});

test('levelFor 分級邊界', () => {
  assert.equal(levelFor(0), '別期待');
  assert.equal(levelFor(24), '別期待');
  assert.equal(levelFor(25), '普通');
  assert.equal(levelFor(49), '普通');
  assert.equal(levelFor(50), '值得一看');
  assert.equal(levelFor(74), '值得一看');
  assert.equal(levelFor(75), '大燒預警');
  assert.equal(levelFor(100), '大燒預警');
});

test('每個因子都有白話理由與實測值字串', () => {
  for (const f of scoreEvent(IDEAL).factors) {
    assert.ok(f.reason.length >= 4, `${f.key} 缺 reason`);
    assert.ok(typeof f.value === 'string' && f.value.length > 0);
    assert.ok(Number.isInteger(f.score));
  }
});

test('每個因子都有 key、繁體中文 name，且 max 等於對應權重', () => {
  const factors = scoreEvent(IDEAL).factors;
  assert.deepEqual(factors.map(f => f.key).sort(), Object.keys(WEIGHTS).sort());
  for (const f of factors) {
    assert.ok(typeof f.key === 'string' && f.key.length > 0, '因子缺 key');
    assert.ok(typeof f.name === 'string' && /[一-鿿]/.test(f.name), `${f.key} 的 name 不是中文字串`);
    assert.equal(f.max, WEIGHTS[f.key], `${f.key} 的 max 與 WEIGHTS 不一致`);
  }
});

test('canvas 斜率三點（12.5→20、77.5→20、61→39）', () => {
  const canvasOf = (mid, high) => scoreEvent({ ...IDEAL, cloudMid: mid, cloudHigh: high }).factors.find(f => f.key === 'canvas').score;
  assert.equal(canvasOf(5, 7.5), 20);    // 合計 12.5：上升段 12.5/25 = 0.5
  assert.equal(canvasOf(40, 37.5), 20);  // 合計 77.5：下降段 (95-77.5)/35 = 0.5
  assert.equal(canvasOf(30, 31), 39);    // 合計 61：下降段 (95-61)/35 ≈ 0.9714 → 38.86 → 39
});

test('aerosol 斜率兩點（AOD 0.5→5、0.035→9）', () => {
  const aerosolOf = aod => scoreEvent({ ...IDEAL, aod }).factors.find(f => f.key === 'aerosol').score;
  assert.equal(aerosolOf(0.5), 5);     // (0.7-0.5)/0.4 = 0.5
  assert.equal(aerosolOf(0.035), 9);   // 0.8 + 0.2*(0.015/0.03) = 0.9
});

test('clarity 中點（濕度 50、能見度 12.5km → 8 分）', () => {
  const r = scoreEvent({ ...IDEAL, humidity: 50, visibility: 12500 });
  // 濕度項 clamp 到 1，能見度項 (12500-5000)/15000 = 0.5，取較差者 → 15*0.5 = 7.5 → 8
  assert.equal(r.factors.find(f => f.key === 'clarity').score, 8);
});

test('interpolate 線性內插', () => {
  const times = [0, 3600_000, 7200_000];
  assert.equal(interpolate(times, [0, 100, 50], 1800_000), 50);
  assert.equal(interpolate(times, [0, 100, 50], 5400_000), 75);
  // 非中點：中點斷言在公式方向顛倒時仍會過，這行才鎖得住方向（顛倒會得 75）
  assert.equal(interpolate(times, [0, 100, 50], 900_000), 25);
});

test('interpolate 恰為整點取原值', () => {
  assert.equal(interpolate([0, 3600_000], [10, 20], 3600_000), 20);
});

test('interpolate 超出範圍 clamp 到端點', () => {
  assert.equal(interpolate([1000, 2000], [5, 9], 0), 5);
  assert.equal(interpolate([1000, 2000], [5, 9], 99999), 9);
});

test('interpolate 單邊 null 取另一邊；雙 null 拋錯', () => {
  assert.equal(interpolate([0, 3600_000], [null, 40], 1800_000), 40);
  assert.equal(interpolate([0, 3600_000], [40, null], 1800_000), 40);
  assert.throws(() => interpolate([0, 3600_000], [null, null], 1800_000));
});

test('非平凡輸入下每個因子分數仍是整數', () => {
  const cases = [
    { ...IDEAL, cloudMid: 5, cloudHigh: 7.5 },
    { ...IDEAL, cloudMid: 30, cloudHigh: 31 },
    { ...IDEAL, aod: 0.035 },
    { ...IDEAL, humidity: 50, visibility: 12500 },
    { ...IDEAL, cloudLow: 35, precipProb: 33 },
  ];
  for (const input of cases) {
    const r = scoreEvent(input);
    for (const f of r.factors) {
      assert.ok(Number.isInteger(f.score), `${f.key} 分數非整數：${f.score}`);
    }
    assert.ok(Number.isInteger(r.score), `總分非整數：${r.score}`);
  }
});
