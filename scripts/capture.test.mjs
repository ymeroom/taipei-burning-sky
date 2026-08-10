import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  camMetrics, CAMERAS, SKY_FRACTION, isSuspect, SUSPECT_WARM_RATIO, framePathFor,
  splitFrames, frameDiff, isStatic,
} from './capture.mjs';
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

// ---- 無訊號偵測：待機卡是靜止圖，真實鏡頭永遠有雜訊 ----

test('splitFrames 依尺寸切出正確幀數', () => {
  const size = 4 * 3 * 3;
  assert.equal(splitFrames(Buffer.alloc(size * 2), 4, 3).length, 2);
  assert.equal(splitFrames(Buffer.alloc(size), 4, 3).length, 1);
  assert.equal(splitFrames(Buffer.alloc(size - 1), 4, 3).length, 0, '不足一幀不該回傳半幀');
  const [a, b] = splitFrames(Buffer.concat([Buffer.alloc(size, 7), Buffer.alloc(size, 9)]), 4, 3);
  assert.equal(a[0], 7);
  assert.equal(b[0], 9);
});

test('frameDiff 回傳平均與最大絕對差；長度不同拋錯', () => {
  assert.deepEqual(frameDiff(Buffer.from([10, 20]), Buffer.from([10, 20])), { mean: 0, max: 0 });
  assert.deepEqual(frameDiff(Buffer.from([0, 0]), Buffer.from([4, 6])), { mean: 5, max: 6 });
  assert.throws(() => frameDiff(Buffer.from([1]), Buffer.from([1, 2])), /長度不同/);
});

test('isStatic：兩幀完全相同判為待機卡', () => {
  const f = Buffer.alloc(300, 128);
  assert.equal(isStatic([f, Buffer.from(f)]), true);
});

// 判準必須是「完全相同」而非平均門檻。實測同一支烘爐地鏡頭：
// 霧雨天 MAD 19.9、平靜晴晨 MAD 僅 0.18（最大差異仍有 45、6.8% 像素在變）。
// 平均值跨場景差兩個數量級，任何固定門檻都會誤判其中一端。
test('isStatic：平靜晴晨的活鏡頭不被誤判（回歸 2026-08-10 的誤判）', () => {
  const n = 3000;
  const a = Buffer.alloc(n, 100);
  const b = Buffer.from(a);
  b[7] = 145;               // 單一像素變動 45，其餘完全相同
  const d = frameDiff(a, b);
  assert.ok(d.mean < 0.02, `平均差極小（${d.mean}），用平均門檻會被判成靜止`);
  assert.equal(d.max, 45);
  assert.equal(isStatic([a, b]), false, '只要有一個像素在動就是活鏡頭');
});

test('isStatic：動態畫面（雨天）當然也不被誤判', () => {
  const a = Buffer.alloc(300, 128);
  const b = Buffer.alloc(300);
  for (let i = 0; i < b.length; i++) b[i] = 128 + (i % 40) - 20;
  assert.equal(isStatic([a, b]), false);
});

test('isStatic：只有一幀時不做判斷（不亂猜）', () => {
  assert.equal(isStatic([Buffer.alloc(300, 5)]), false);
  assert.equal(isStatic([]), false);
});

test('待機卡情境：靜止的夕陽底圖同時觸發無訊號與高暖色，兩道防線都攔得住', () => {
  // 新北觀旅局的待機卡上緣是一張夕陽照，暖色比例極高但畫面完全不動
  const w = 20, h = 20, size = w * h * 3;
  const card = Buffer.alloc(size);
  const skyRows = Math.round(h * SKY_FRACTION);
  for (let y = 0; y < h; y++) {
    const [r, g, b] = y < skyRows ? [235, 120, 80] : [30, 30, 40];
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      card[i] = r; card[i + 1] = g; card[i + 2] = b;
    }
  }
  const twoFrames = Buffer.concat([card, card]);
  const frames = splitFrames(twoFrames, w, h);
  const m = camMetrics(twoFrames, w, h);
  assert.equal(isStatic(frames), true, '主要防線：畫面靜止');
  assert.equal(isSuspect(m), true, '次要防線：整片天暖色');
  assert.equal(m.camBurnIndex, 100, '若兩道都沒攔，就會變成假的滿分');
});

// ---- 可疑量測偵測 ----

test('isSuspect：整片天均勻轉暖判為可疑', () => {
  // 2026-08-09 日出的實際數值：預報 16 分的爛天氣卻量到 0.991，人眼確認沒有霞光
  assert.equal(isSuspect({ camWarmRatio: 0.991 }), true);
});

test('isSuspect：真實霞光不會被誤判', () => {
  // 2026-08-07 日落是確認有燒的一次，暖色只佔 17.1%
  assert.equal(isSuspect({ camWarmRatio: 0.171 }), false);
  assert.equal(isSuspect({ camWarmRatio: 0 }), false);
  assert.equal(isSuspect({ camWarmRatio: 0.85 }), false, '八成五仍屬可能的大範圍霞光');
});

test('isSuspect 門檻邊界：恰等於門檻不算可疑', () => {
  assert.equal(SUSPECT_WARM_RATIO, 0.9);
  assert.equal(isSuspect({ camWarmRatio: 0.9 }), false);
  assert.equal(isSuspect({ camWarmRatio: 0.901 }), true);
});

test('framePathFor 產生 docs/ 相對路徑', () => {
  assert.equal(framePathFor('2026-08-09', 'sunrise'), 'frames/2026-08-09-sunrise.jpg');
  assert.equal(framePathFor('2026-08-09', 'sunset'), 'frames/2026-08-09-sunset.jpg');
});

test('camMetrics 全暖天空的 warmRatio 會落在可疑範圍', () => {
  const m = camMetrics(frame(20, 20, [230, 110, 70], [40, 40, 40]), 20, 20);
  assert.equal(m.camWarmRatio, 1);
  assert.equal(isSuspect(m), true, '滿版暖色應被標記，即使 burnIndex 是 100');
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

// upsert 是 Object.assign：省略鍵會讓舊值殘留。可疑旗標必須能被後續正常量測清掉。
test('upsertVerification：重跑量到正常值時，舊的 suspect 旗標會被清除', () => {
  const records = [{ date: '2026-08-09', kind: 'sunrise', camBurnIndex: 100, suspect: true, suspectReason: '暖色比例過高' }];
  upsertVerification(records, {
    date: '2026-08-09', kind: 'sunrise', camBurnIndex: 12,
    suspect: undefined, suspectReason: undefined,
  });
  const after = JSON.parse(JSON.stringify(records[0]));
  assert.equal(after.camBurnIndex, 12);
  assert.equal('suspect' in after, false, 'suspect 應被清掉而非殘留');
  assert.equal('suspectReason' in after, false);
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
