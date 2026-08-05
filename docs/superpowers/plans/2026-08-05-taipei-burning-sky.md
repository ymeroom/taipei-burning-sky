# 台北火燒雲預報網站 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立零維護靜態網站，每日台北時間 15:00 / 23:30 由 GitHub Actions 自動計算並發佈台北市日出／日落火燒雲機率。

**Architecture:** GitHub Actions cron 執行 Node 腳本（抓 Open-Meteo 天氣與空品 API → 純函式評分 → 寫 `docs/data.json` 與 `docs/history.json` → commit），GitHub Pages 從 `/docs` 發佈純靜態單頁網站。

**Tech Stack:** Node 20（零外部依賴、`node --test`）、GitHub Actions、GitHub Pages、原生 HTML/CSS/JS。

**Spec:** `docs/superpowers/specs/2026-08-05-taipei-burning-sky-design.md`

## Global Constraints

- 專案根目錄：`D:\taipei-burning-sky`（已 git init，main 分支）
- Node 20+，**禁止任何 npm 依賴**（無 package.json 也可以，`node --test scripts/` 直接跑）
- 網站發佈根目錄 = `docs/`（GitHub Pages source: main branch `/docs`）
- 位置常數：緯度 `25.04`、經度 `121.56`、時區 `Asia/Taipei`（UTC+8 固定無夏令）
- 權重常數（總分 100）：canvas 40、lowCloud 25、clarity 15、aerosol 10、rain 10
- 等級：0–24 別期待｜25–49 普通｜50–74 值得一看｜75–100 大燒預警
- 所有使用者可見文字為繁體中文
- Commit 訊息結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Windows 環境，shell 指令以 Git Bash（POSIX）語法為準

## File Structure

```
taipei-burning-sky/
├── .github/workflows/update.yml   # Task 5：排程 + 手動觸發 + commit 回寫
├── scripts/
│   ├── score.mjs                  # Task 1+2：純函式（因子計分、scoreEvent、levelFor、interpolate）
│   ├── score.test.mjs             # Task 1+2：單元測試
│   ├── update.mjs                 # Task 3：抓 API（含重試）→ 組資料 → 寫 JSON
│   └── update.test.mjs            # Task 3：fetchJsonWithRetry 測試（注入假 fetch）
├── docs/
│   ├── index.html                 # Task 4：單頁網站（內嵌 CSS/JS）
│   ├── data.json                  # Task 3 產出（跑一次 update.mjs 生成真資料）
│   └── history.json               # Task 3 產出
└── README.md                      # Task 5
```

---

### Task 1: 評分模組 `score.mjs`（五因子 + scoreEvent + levelFor）

**Files:**
- Create: `scripts/score.mjs`
- Test: `scripts/score.test.mjs`

**Interfaces:**
- Produces:
  - `WEIGHTS = { canvas: 40, lowCloud: 25, clarity: 15, aerosol: 10, rain: 10 }`
  - `levelFor(score: number): string` — 回傳等級標籤
  - `scoreEvent(cond): { score: number, level: string, factors: Factor[] }`
    - `cond = { cloudLow, cloudMid, cloudHigh, humidity, visibility, aod, precipProb }`（visibility 單位公尺，其餘 % 或無因次 AOD）
    - `Factor = { key, name, value, score, max, reason }`（score 已四捨五入為整數；總分 = 各因子整數分之和）

- [ ] **Step 1: 寫失敗測試**

建立 `scripts/score.test.mjs`：

```js
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /d/taipei-burning-sky && node --test scripts/`
Expected: FAIL（`Cannot find module ... score.mjs`）

- [ ] **Step 3: 實作 `scripts/score.mjs`**

```js
// 台北火燒雲評分：純函式，輸入事件時刻的氣象數值，輸出 0-100 分與五因子拆解。
// 權重與曲線斷點集中在此，日後依實際準確度微調。

export const WEIGHTS = { canvas: 40, lowCloud: 25, clarity: 15, aerosol: 10, rain: 10 };

const LEVELS = [
  { min: 75, label: '大燒預警' },
  { min: 50, label: '值得一看' },
  { min: 25, label: '普通' },
  { min: 0, label: '別期待' },
];

export function levelFor(score) {
  return LEVELS.find(l => score >= l.min).label;
}

const clamp01 = x => Math.min(1, Math.max(0, x));

// 中高雲畫布：25-60% 滿分鐘形，0% 與 ≥95% 為 0
function canvasFactor(mid, high) {
  const combined = Math.min(100, mid + high);
  let ratio, reason;
  if (combined <= 0) { ratio = 0; reason = '天上幾乎沒有中高雲，沒有畫布可燒'; }
  else if (combined < 25) { ratio = combined / 25; reason = '中高雲偏少，就算燒起來範圍也有限'; }
  else if (combined <= 60) { ratio = 1; reason = '中高雲量恰到好處，畫布漂亮'; }
  else if (combined < 95) { ratio = (95 - combined) / 35; reason = '中高雲偏厚，陽光較難透入染色'; }
  else { ratio = 0; reason = '天空整片糊住，光透不進來'; }
  return { key: 'canvas', name: '中高雲畫布', value: `中高雲合計 ${Math.round(combined)}%`,
           score: Math.round(WEIGHTS.canvas * ratio), max: WEIGHTS.canvas, reason };
}

// 低雲阻擋：0% 滿分，線性遞減至 70% 為 0
function lowCloudFactor(low) {
  const ratio = clamp01(1 - low / 70);
  const reason = low <= 5 ? '低空乾淨，光路無阻'
    : low < 30 ? '少量低雲，稍有遮擋'
    : low < 70 ? '低雲偏多，地平線光線容易被擋'
    : '低雲封死地平線，光進不來';
  return { key: 'lowCloud', name: '低雲阻擋', value: `低雲 ${Math.round(low)}%`,
           score: Math.round(WEIGHTS.lowCloud * ratio), max: WEIGHTS.lowCloud, reason };
}

// 空氣通透度：濕度 ≤60 且能見度 ≥20km 滿分；濕度 ≥95 或能見度 ≤5km 為 0（取兩者較差）
function clarityFactor(humidity, visibility) {
  const h = clamp01((95 - humidity) / 35);
  const v = clamp01((visibility - 5000) / 15000);
  const ratio = Math.min(h, v);
  const reason = ratio >= 0.8 ? '空氣乾爽通透，顏色會很飽和'
    : ratio >= 0.4 ? '濕度或能見度普通，顏色打點折扣'
    : '空氣又濕又濁，色彩會很淡';
  return { key: 'clarity', name: '空氣通透度', value: `濕度 ${Math.round(humidity)}%・能見度 ${(visibility / 1000).toFixed(0)}km`,
           score: Math.round(WEIGHTS.clarity * ratio), max: WEIGHTS.clarity, reason };
}

// 氣溶膠：0.05-0.3 理想；>0.7 為 0；<0.02 微扣（0.8）
function aerosolFactor(aod) {
  let ratio, reason;
  if (aod > 0.7) { ratio = 0; reason = '氣溶膠過高，天空會灰濛一片'; }
  else if (aod > 0.3) { ratio = (0.7 - aod) / 0.4; reason = '空氣偏髒，紅光會被壓暗'; }
  else if (aod >= 0.05) { ratio = 1; reason = '氣溶膠適中，散射出漂亮橘紅'; }
  else if (aod >= 0.02) { ratio = 0.8 + 0.2 * (aod - 0.02) / 0.03; reason = '空氣乾淨，色彩清亮'; }
  else { ratio = 0.8; reason = '空氣極乾淨，紅光略淡但通透'; }
  return { key: 'aerosol', name: '氣溶膠', value: `AOD ${aod.toFixed(2)}`,
           score: Math.round(WEIGHTS.aerosol * ratio), max: WEIGHTS.aerosol, reason };
}

// 降雨干擾：0% 滿分，線性遞減至 80% 為 0
function rainFactor(precipProb) {
  const ratio = clamp01(1 - precipProb / 80);
  const reason = precipProb <= 10 ? '無降雨干擾'
    : precipProb < 50 ? '有些降雨機率，可能攪局'
    : '降雨機率高，大概率泡湯';
  return { key: 'rain', name: '降雨干擾', value: `降雨機率 ${Math.round(precipProb)}%`,
           score: Math.round(WEIGHTS.rain * ratio), max: WEIGHTS.rain, reason };
}

export function scoreEvent({ cloudLow, cloudMid, cloudHigh, humidity, visibility, aod, precipProb }) {
  const factors = [
    canvasFactor(cloudMid, cloudHigh),
    lowCloudFactor(cloudLow),
    clarityFactor(humidity, visibility),
    aerosolFactor(aod),
    rainFactor(precipProb),
  ];
  const score = factors.reduce((sum, f) => sum + f.score, 0);
  return { score, level: levelFor(score), factors };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd /d/taipei-burning-sky && node --test scripts/`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
cd /d/taipei-burning-sky && git add scripts/ && git commit -m "feat: 五因子火燒雲評分模組（純函式 + 單元測試）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 時間插值函式 `interpolate`

**Files:**
- Modify: `scripts/score.mjs`（檔尾追加 export）
- Modify: `scripts/score.test.mjs`（追加測試）

**Interfaces:**
- Produces: `interpolate(times: number[], values: (number|null)[], target: number): number`
  - `times` 為遞增 epoch 毫秒陣列，`target` 落在範圍外時取端點值（clamp）
  - 相鄰值其一為 `null` 時取另一個；兩者皆 `null` 時 throw

- [ ] **Step 1: 追加失敗測試到 `scripts/score.test.mjs`**

```js
import { interpolate } from './score.mjs'; // 併入檔頂既有 import

test('interpolate 線性內插', () => {
  const times = [0, 3600_000, 7200_000];
  assert.equal(interpolate(times, [0, 100, 50], 1800_000), 50);
  assert.equal(interpolate(times, [0, 100, 50], 5400_000), 75);
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
```

- [ ] **Step 2: 跑測試確認新測試失敗**

Run: `cd /d/taipei-burning-sky && node --test scripts/`
Expected: 新增測試 FAIL（interpolate is not exported）

- [ ] **Step 3: 在 `scripts/score.mjs` 檔尾實作**

```js
// 對 Open-Meteo 每小時序列做線性插值，取得事件時刻（如日落 17:43）的數值。
export function interpolate(times, values, target) {
  if (target <= times[0]) return firstNonNull(values[0], values[1]);
  const last = times.length - 1;
  if (target >= times[last]) return firstNonNull(values[last], values[last - 1]);
  let i = times.findIndex(t => t >= target);
  const t0 = times[i - 1], t1 = times[i];
  const v0 = values[i - 1], v1 = values[i];
  if (v0 == null && v1 == null) throw new Error(`interpolate: 兩端皆為 null（index ${i}）`);
  if (v0 == null) return v1;
  if (v1 == null) return v0;
  return v0 + (v1 - v0) * ((target - t0) / (t1 - t0));
}

function firstNonNull(a, b) {
  if (a != null) return a;
  if (b != null) return b;
  throw new Error('interpolate: 端點皆為 null');
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd /d/taipei-burning-sky && node --test scripts/`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
cd /d/taipei-burning-sky && git add scripts/ && git commit -m "feat: 事件時刻線性插值函式

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 更新腳本 `update.mjs`（抓取、重試、組裝、寫檔）

**Files:**
- Create: `scripts/update.mjs`
- Test: `scripts/update.test.mjs`

**Interfaces:**
- Consumes: `scoreEvent`, `interpolate`（Task 1/2）
- Produces:
  - `fetchJsonWithRetry(url, fetchImpl = fetch, delays = [1000, 4000, 9000]): Promise<any>`
  - CLI：`node scripts/update.mjs [trigger]`（trigger 預設 `manual`）→ 寫 `docs/data.json`、append `docs/history.json`
  - `data.json` / `history.json` 結構如 spec「資料格式」節（Task 4 前端依此讀取）

- [ ] **Step 1: 寫失敗測試 `scripts/update.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJsonWithRetry } from './update.mjs';

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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /d/taipei-burning-sky && node --test scripts/`
Expected: update.test FAIL（Cannot find module update.mjs）

- [ ] **Step 3: 實作 `scripts/update.mjs`**

```js
// 抓 Open-Meteo 天氣 + 空品 → 算下一場日出/日落火燒雲分數 → 寫 docs/data.json、append docs/history.json
// 用法：node scripts/update.mjs [trigger]   trigger ∈ sunset-run | sunrise-run | manual
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { scoreEvent, interpolate } from './score.mjs';

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

function conditionsAt(forecast, air, epoch) {
  const wt = forecast.hourly.time.map(toEpoch);
  const at = air.hourly.time.map(toEpoch);
  const w = key => interpolate(wt, forecast.hourly[key], epoch);
  return {
    cloudLow: w('cloud_cover_low'),
    cloudMid: w('cloud_cover_mid'),
    cloudHigh: w('cloud_cover_high'),
    humidity: w('relative_humidity_2m'),
    visibility: w('visibility'),
    precipProb: w('precipitation_probability'),
    aod: interpolate(at, air.hourly.aerosol_optical_depth, epoch),
  };
}

function evaluate(forecast, air, iso) {
  return { eventTime: `${iso}:00+08:00`, ...scoreEvent(conditionsAt(forecast, air, toEpoch(iso))) };
}

export function buildData(forecast, air, trigger, now) {
  const events = forecast.daily.time.flatMap((_, i) => [
    { kind: 'sunrise', iso: forecast.daily.sunrise[i] },
    { kind: 'sunset', iso: forecast.daily.sunset[i] },
  ]).map(e => ({ ...e, epoch: toEpoch(e.iso) }))
    .filter(e => e.epoch > now)
    .sort((a, b) => a.epoch - b.epoch);

  const nextSunrise = events.find(e => e.kind === 'sunrise');
  const nextSunset = events.find(e => e.kind === 'sunset');

  // 趨勢：接下來 3 天（跳過下一場所屬事件之後，仍完整列出每天日出日落總分）
  const firstEpoch = Math.min(nextSunrise.epoch, nextSunset.epoch);
  const outlook = forecast.daily.time
    .map((date, i) => ({ date, sunriseIso: forecast.daily.sunrise[i], sunsetIso: forecast.daily.sunset[i] }))
    .filter(d => toEpoch(d.sunriseIso) > firstEpoch || toEpoch(d.sunsetIso) > firstEpoch)
    .slice(0, 3)
    .map(d => ({
      date: d.date,
      sunrise: { time: `${d.sunriseIso}:00+08:00`, score: evaluate(forecast, air, d.sunriseIso).score },
      sunset: { time: `${d.sunsetIso}:00+08:00`, score: evaluate(forecast, air, d.sunsetIso).score },
    }));

  return {
    generatedAt: new Date(now).toISOString(),
    trigger,
    next: {
      sunrise: evaluate(forecast, air, nextSunrise.iso),
      sunset: evaluate(forecast, air, nextSunset.iso),
    },
    outlook,
  };
}

async function main() {
  const trigger = process.argv[2] || 'manual';
  const [forecast, air] = await Promise.all([
    fetchJsonWithRetry(FORECAST_URL),
    fetchJsonWithRetry(AIR_URL),
  ]);
  const data = buildData(forecast, air, trigger, Date.now());
  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');

  let history = [];
  try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf8')); } catch { /* 首次執行 */ }
  history.push({
    ranAt: data.generatedAt,
    trigger,
    sunriseScore: data.next.sunrise.score,
    sunsetScore: data.next.sunset.score,
    sunriseTime: data.next.sunrise.eventTime,
    sunsetTime: data.next.sunset.eventTime,
  });
  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
  console.log(`OK trigger=${trigger} sunrise=${data.next.sunrise.score} sunset=${data.next.sunset.score}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd /d/taipei-burning-sky && node --test scripts/`
Expected: 全部 PASS

- [ ] **Step 5: 端對端 smoke——真跑一次產生首份資料**

Run: `cd /d/taipei-burning-sky && node scripts/update.mjs manual && cat docs/data.json | head -40 && cat docs/history.json`
Expected: 印出 `OK trigger=manual ...`；`docs/data.json` 含 `next.sunrise`、`next.sunset`（各含 5 個 factors）與 3 筆 `outlook`；`history.json` 恰 1 筆。人工確認 eventTime 合理（日出約 05:2x、日落約 18:3x，+08:00）。

- [ ] **Step 6: Commit**

```bash
cd /d/taipei-burning-sky && git add scripts/ docs/data.json docs/history.json && git commit -m "feat: Open-Meteo 抓取與資料組裝腳本，附首份真實資料

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 前端單頁 `docs/index.html`

**Files:**
- Create: `docs/index.html`

**Interfaces:**
- Consumes: `docs/data.json`、`docs/history.json`（Task 3 已產出真資料，結構見 spec）

**設計要求（spec UI 節）**：深色天空漸層、繁中、手機優先；主卡（時間較近的事件）＋副卡；五條因子橫桿；未來 3 天趨勢；最近 14 筆歷史；`generatedAt` 超過 12 小時顯示過期警示；JSON 載入失敗顯示錯誤與重試按鈕；頁尾含資料來源與演算法摺疊說明。

- [ ] **Step 1: 建立 `docs/index.html`（完整檔案）**

```html
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>台北火燒雲預報</title>
<style>
  :root {
    --lv0: #55607a; --lv1: #8899bb; --lv2: #ff9f43; --lv3: #ff5e3a;
    --card: rgba(255,255,255,.06); --line: rgba(255,255,255,.12); --dim: #9aa3c0;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: "Noto Sans TC", system-ui, sans-serif; color: #eef1fa; min-height: 100vh;
    background: linear-gradient(175deg, #0b1026 0%, #1a1440 45%, #3d1f47 75%, #6b2d3e 100%);
    background-attachment: fixed; padding: 20px 16px 40px;
  }
  main { max-width: 640px; margin: 0 auto; display: grid; gap: 14px; }
  h1 { font-size: 1.35rem; letter-spacing: .12em; text-align: center; padding: 8px 0 2px; }
  .sub { text-align: center; color: var(--dim); font-size: .8rem; margin-bottom: 6px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 18px; backdrop-filter: blur(6px); }
  .stale { background: #7a2e2e; border-color: #a54; text-align: center; font-size: .9rem; padding: 10px; border-radius: 12px; }
  .main-card { text-align: center; padding: 26px 18px; }
  .kind { font-size: 1rem; color: var(--dim); letter-spacing: .3em; }
  .score { font-size: 4.2rem; font-weight: 800; line-height: 1.15; }
  .level { display: inline-block; padding: 3px 14px; border-radius: 999px; font-size: .95rem; font-weight: 700; color: #101425; }
  .when { margin-top: 10px; color: var(--dim); font-size: .9rem; }
  .second { display: flex; justify-content: space-between; align-items: center; }
  .second .score { font-size: 2rem; }
  h2 { font-size: .95rem; color: var(--dim); letter-spacing: .2em; margin-bottom: 10px; }
  .factor { margin-bottom: 12px; }
  .factor:last-child { margin-bottom: 0; }
  .frow { display: flex; justify-content: space-between; font-size: .88rem; margin-bottom: 4px; }
  .frow b { font-weight: 600; }
  .fscore { color: var(--dim); }
  .bar { height: 6px; background: rgba(255,255,255,.1); border-radius: 3px; overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #ff9f43, #ff5e3a); }
  .freason { font-size: .78rem; color: var(--dim); margin-top: 3px; }
  .fvalue { font-size: .78rem; color: #c7cde4; }
  .outlook { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .day { text-align: center; background: rgba(255,255,255,.04); border-radius: 12px; padding: 10px 6px; font-size: .82rem; }
  .day .d { color: var(--dim); margin-bottom: 6px; }
  .day .s { font-weight: 700; font-size: 1.05rem; }
  table { width: 100%; border-collapse: collapse; font-size: .82rem; }
  th, td { padding: 6px 4px; text-align: center; border-bottom: 1px solid var(--line); }
  th { color: var(--dim); font-weight: 500; }
  footer { text-align: center; color: var(--dim); font-size: .75rem; line-height: 1.9; margin-top: 8px; }
  footer a { color: #aab6e0; }
  details { text-align: left; margin-top: 8px; }
  summary { cursor: pointer; text-align: center; }
  #error { display: none; text-align: center; padding: 30px 16px; }
  button { background: var(--card); color: inherit; border: 1px solid var(--line); border-radius: 10px; padding: 8px 22px; font-size: .95rem; cursor: pointer; margin-top: 12px; }
</style>
</head>
<body>
<main>
  <h1>台北火燒雲預報</h1>
  <div class="sub">每日 15:00・23:30 自動更新｜台北市</div>
  <div id="stale" class="stale" hidden></div>
  <div id="error" class="card"></div>
  <div id="app" hidden>
    <div style="display:grid;gap:14px">
      <section id="main-card" class="card main-card"></section>
      <section id="second-card" class="card second"></section>
      <section class="card"><h2>因子拆解（主要事件）</h2><div id="factors"></div></section>
      <section class="card"><h2>未來趨勢</h2><div id="outlook" class="outlook"></div></section>
      <section class="card"><h2>歷史紀錄</h2><table>
        <thead><tr><th>執行時間</th><th>觸發</th><th>日出</th><th>日落</th></tr></thead>
        <tbody id="history"></tbody></table></section>
    </div>
  </div>
  <footer>
    <span id="gen"></span><br>
    氣象資料：<a href="https://open-meteo.com/" rel="noopener">Open-Meteo</a>（天氣＋空氣品質）｜僅供參考，天空不保證照劇本走
    <details><summary>演算法說明</summary>
      總分 100 =中高雲畫布 40 +低雲阻擋 25 +空氣通透度 15 +氣溶膠 10 +降雨干擾 10。
      火燒雲需要中高雲當畫布（約 25–60% 最佳）、低空無遮擋讓夕陽光斜射進來、乾燥通透的空氣讓顏色飽和。
      分數於每日 15:00（今晚日落）與 23:30（明早日出）依 Open-Meteo 預報重算。
    </details>
  </footer>
</main>
<script>
const LV = s => s >= 75 ? ['大燒預警','var(--lv3)'] : s >= 50 ? ['值得一看','var(--lv2)'] : s >= 25 ? ['普通','var(--lv1)'] : ['別期待','var(--lv0)'];
const KIND = { sunrise: '日出', sunset: '日落' };
const pad = n => String(n).padStart(2, '0');
const fmtTime = iso => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = iso => { const d = new Date(iso); return `${d.getMonth()+1}/${d.getDate()}`; };

function countdown(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return '進行中／已結束';
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000);
  return h > 0 ? `還有 ${h} 小時 ${m} 分` : `還有 ${m} 分`;
}

function render(data, history) {
  const pair = [['sunrise', data.next.sunrise], ['sunset', data.next.sunset]]
    .sort((a, b) => new Date(a[1].eventTime) - new Date(b[1].eventTime));
  const [mainKind, main] = pair[0], [secKind, sec] = pair[1];

  const [lvl, color] = LV(main.score);
  document.getElementById('main-card').innerHTML =
    `<div class="kind">下一場・${KIND[mainKind]}</div>
     <div class="score" style="color:${color}">${main.score}</div>
     <span class="level" style="background:${color}">${lvl}</span>
     <div class="when">${fmtDate(main.eventTime)} ${fmtTime(main.eventTime)} ${KIND[mainKind]}・${countdown(main.eventTime)}</div>`;

  const [slvl, scolor] = LV(sec.score);
  document.getElementById('second-card').innerHTML =
    `<div><div class="kind">再下一場・${KIND[secKind]}</div>
     <div class="when">${fmtDate(sec.eventTime)} ${fmtTime(sec.eventTime)}</div></div>
     <div style="text-align:right"><div class="score" style="color:${scolor}">${sec.score}</div>
     <span class="level" style="background:${scolor}">${slvl}</span></div>`;

  document.getElementById('factors').innerHTML = main.factors.map(f =>
    `<div class="factor">
       <div class="frow"><b>${f.name}</b><span class="fscore">${f.score} / ${f.max}</span></div>
       <div class="bar"><i style="width:${f.max ? f.score / f.max * 100 : 0}%"></i></div>
       <div class="freason">${f.reason}<span class="fvalue">（${f.value}）</span></div>
     </div>`).join('');

  document.getElementById('outlook').innerHTML = data.outlook.map(d =>
    `<div class="day"><div class="d">${fmtDate(d.date + 'T00:00:00+08:00')}</div>
      <div>日出 <span class="s" style="color:${LV(d.sunrise.score)[1]}">${d.sunrise.score}</span></div>
      <div>日落 <span class="s" style="color:${LV(d.sunset.score)[1]}">${d.sunset.score}</span></div></div>`).join('');

  document.getElementById('history').innerHTML = history.slice(-14).reverse().map(h => {
    const d = new Date(h.ranAt);
    return `<tr><td>${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}</td>
      <td>${h.trigger === 'sunset-run' ? '日落場' : h.trigger === 'sunrise-run' ? '日出場' : '手動'}</td>
      <td style="color:${LV(h.sunriseScore)[1]}">${h.sunriseScore}</td>
      <td style="color:${LV(h.sunsetScore)[1]}">${h.sunsetScore}</td></tr>`;
  }).join('');

  const gen = new Date(data.generatedAt);
  document.getElementById('gen').textContent =
    `資料更新於 ${gen.getMonth()+1}/${gen.getDate()} ${pad(gen.getHours())}:${pad(gen.getMinutes())}（台北時間）`;
  const hours = (Date.now() - gen) / 3600000;
  const stale = document.getElementById('stale');
  if (hours > 12) { stale.hidden = false; stale.textContent = `⚠ 資料已 ${Math.floor(hours)} 小時未更新，可能排程失敗，分數僅供參考`; }
  document.getElementById('app').hidden = false;
}

async function load() {
  document.getElementById('error').style.display = 'none';
  try {
    const bust = `?t=${Date.now()}`;
    const [data, history] = await Promise.all([
      fetch('data.json' + bust).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch('history.json' + bust).then(r => r.ok ? r.json() : []),
    ]);
    render(data, history);
  } catch (err) {
    const el = document.getElementById('error');
    el.style.display = 'block';
    el.innerHTML = `<p>資料載入失敗（${err.message}）</p><button onclick="load()">重試</button>`;
  }
}
load();
setInterval(load, 15 * 60 * 1000); // 開著頁面時每 15 分鐘自動重載資料
</script>
</body>
</html>
```

- [ ] **Step 2: 本機起靜態伺服器驗證**

Run: `cd /d/taipei-burning-sky && npx -y http-server docs -p 8877 -s &`（背景執行）
然後用 browser-cli skill（本使用者指定的瀏覽器工具）開 `http://localhost:8877`，逐項檢查：
- 主卡顯示時間較近的事件、分數配色與等級標籤正確
- 五條因子桿寬度 = score/max，理由與實測值顯示
- 趨勢 3 天、歷史表 1 筆（Task 3 產的首筆）
- 手機寬度（375px）版面不破
- 把 `data.json` 的 `generatedAt` 手動改成 20 小時前再重整 → 出現過期警示（驗完改回）
- 暫時把 fetch 網址改錯測錯誤畫面 → 顯示錯誤與重試鈕（驗完改回）

Expected: 全部通過，截圖確認視覺。驗完 kill http-server。

- [ ] **Step 3: Commit**

```bash
cd /d/taipei-burning-sky && git add docs/index.html && git commit -m "feat: 火燒雲預報單頁前端（深色天空風格、因子拆解、趨勢與歷史）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: GitHub Actions workflow 與 README

**Files:**
- Create: `.github/workflows/update.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: `node scripts/update.mjs <trigger>`（Task 3 CLI）、`node --test scripts/`（Task 1–3 測試）

- [ ] **Step 1: 建立 `.github/workflows/update.yml`**

```yaml
name: 更新火燒雲預報

on:
  schedule:
    - cron: '0 7 * * *'    # 台北 15:00 → 今晚日落
    - cron: '30 15 * * *'  # 台北 23:30 → 明早日出
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: update-forecast
  cancel-in-progress: false

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: 單元測試
        run: node --test scripts/
      - name: 計算預報
        run: node scripts/update.mjs "${{ github.event.schedule == '0 7 * * *' && 'sunset-run' || (github.event.schedule == '30 15 * * *' && 'sunrise-run' || 'manual') }}"
      - name: Commit 資料
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add docs/data.json docs/history.json
          git diff --cached --quiet || git commit -m "chore: 更新預報資料"
          git push
```

- [ ] **Step 2: 建立 `README.md`**

```markdown
# 台北火燒雲預報 🌇

每日台北時間 **15:00**（今晚日落）與 **23:30**（明早日出）自動更新，
預測台北市日出／日落出現火燒雲的機率。

**網站：** https://ymeroom.github.io/taipei-burning-sky/

## 運作方式

GitHub Actions 依排程執行 `scripts/update.mjs`：

1. 抓取 [Open-Meteo](https://open-meteo.com/) 天氣預報（分層雲量、濕度、能見度、降雨機率、日出日落時刻）與空氣品質（氣溶膠光學厚度 AOD）
2. 以事件時刻做線性插值，五因子加權評分（滿分 100）：
   中高雲畫布 40・低雲阻擋 25・空氣通透度 15・氣溶膠 10・降雨干擾 10
3. 寫入 `docs/data.json`（最新預測）與 `docs/history.json`（歷史紀錄），commit 後 GitHub Pages 自動重新發佈

等級：0–24 別期待｜25–49 普通｜50–74 值得一看｜75–100 大燒預警

## 本機開發

```bash
node --test scripts/        # 單元測試
node scripts/update.mjs     # 手動抓一次資料
npx http-server docs        # 本機預覽
```

僅供參考——天空從不照劇本走。
```

- [ ] **Step 3: 本機驗證 workflow 語法**

Run: `cd /d/taipei-burning-sky && node --test scripts/ && node -e "console.log('yml exists:', require('fs').existsSync('.github/workflows/update.yml'))"`
Expected: 測試全過、`yml exists: true`（cron 正確性由 Task 6 線上 dispatch 驗證）

- [ ] **Step 4: Commit**

```bash
cd /d/taipei-burning-sky && git add .github README.md && git commit -m "feat: GitHub Actions 排程 workflow 與 README

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 建 GitHub repo、開 Pages、端對端驗證

**Files:**
- 無新檔案（部署與驗證）

**Interfaces:**
- Consumes: 完整 repo（Task 1–5）、`gh` CLI（已登入 ymeroom 帳號）

- [ ] **Step 1: 建立公開 repo 並推送**

```bash
cd /d/taipei-burning-sky && gh repo create taipei-burning-sky --public --source=. --push --description "台北火燒雲預報：每日兩次自動更新日出日落霞光機率"
```

Expected: repo `ymeroom/taipei-burning-sky` 建立且 main 已推上。

- [ ] **Step 2: 啟用 GitHub Pages（main /docs）**

```bash
gh api repos/ymeroom/taipei-burning-sky/pages -X POST -f "source[branch]=main" -f "source[path]=/docs"
```

Expected: HTTP 201。若回 409（已存在）改用 `-X PUT` 更新設定。

- [ ] **Step 3: 手動 dispatch 一次 workflow**

```bash
gh workflow run update.yml --repo ymeroom/taipei-burning-sky && sleep 60 && gh run list --workflow=update.yml --repo ymeroom/taipei-burning-sky --limit 1
```

Expected: 最新 run `completed success`。若失敗，`gh run view <id> --log-failed` 查原因並修復。

- [ ] **Step 4: 線上驗證網站**

用 browser-cli skill 開 `https://ymeroom.github.io/taipei-burning-sky/`（Pages 首次發佈可能需等 1–3 分鐘）：
- 頁面正常渲染、分數與本機一致或更新
- `history.json` 已由 dispatch 新增一筆（歷史表 ≥2 筆）

Expected: 全部通過。

- [ ] **Step 5: 拉回遠端 commit、收尾**

```bash
cd /d/taipei-burning-sky && git pull --rebase
```

Expected: 取回 Actions bot 的資料 commit，本機與遠端同步。完成後回報網站網址與兩個排程時刻。
