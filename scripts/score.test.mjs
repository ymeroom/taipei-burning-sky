import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEvent, levelFor, WEIGHTS } from './score.mjs';

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
  const a = scoreEvent({ ...IDEAL, cloudMid: 60, cloudHigh: 70 });
  const b = scoreEvent({ ...IDEAL, cloudMid: 50, cloudHigh: 50 });
  assert.equal(a.factors.find(f => f.key === 'canvas').score,
               b.factors.find(f => f.key === 'canvas').score);
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
