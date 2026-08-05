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
