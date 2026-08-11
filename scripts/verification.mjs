// 驗證資料的共用邏輯：讀寫 docs/verification.json、與 history 對帳。純函式為主，零依賴。
import { readFile, writeFile } from 'node:fs/promises';

export const VERIFICATION_PATH = new URL('../docs/verification.json', import.meta.url);

export function taipeiToday(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
}

export const DEFAULT_LOCATION_ID = 'taipei';

// 多地點之前的紀錄沒有地點欄位，一律視為台北
const locOf = rec => rec.location ?? DEFAULT_LOCATION_ID;

// 從 history 找當天該地該場事件的最新一筆預測。
// 新格式把各地資料收在 locations[<id>] 底下；舊格式欄位直接在頂層，視為台北。
export function findTodayPrediction(history, kind, taipeiDate, locationId = DEFAULT_LOCATION_ID) {
  const timeKey = `${kind}Time`, scoreKey = `${kind}Score`, factorsKey = `${kind}Factors`;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const entry = h.locations
      ? h.locations[locationId]
      : (locationId === DEFAULT_LOCATION_ID ? h : undefined);
    if (!entry) continue;
    if (typeof entry[timeKey] === 'string' && entry[timeKey].slice(0, 10) === taipeiDate) {
      return { eventTime: entry[timeKey], predictedScore: entry[scoreKey], factors: entry[factorsKey] ?? null };
    }
  }
  return null;
}

// 以 (date, kind, location) upsert：同一場事件的多個訊號各寫自己的欄位，互不覆蓋
export function upsertVerification(records, rec) {
  const existing = records.find(r =>
    r.date === rec.date && r.kind === rec.kind && locOf(r) === locOf(rec));
  if (existing) Object.assign(existing, rec);
  else records.push(rec);
  return records;
}

// 只有「檔案不存在」算首次執行；壞檔一律往外拋，不讓一次 parse 失敗清空既有紀錄
export async function readJsonArray(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`readJsonArray: ${path} 內容不是陣列，拒絕覆寫`);
  return parsed;
}

export async function writeJsonArray(path, records) {
  await writeFile(path, JSON.stringify(records, null, 2) + '\n');
}
