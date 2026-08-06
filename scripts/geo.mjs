// 太陽方位角（NOAA 一般太陽位置演算法）與大圓取點。純函式、零依賴。
// 光路取樣用：日落/日出時刻的太陽方位角決定光從哪個方向進來。

const RAD = Math.PI / 180;
const clamp1 = x => Math.min(1, Math.max(-1, x));

// dateMs: epoch 毫秒；lat/lon: 度（東經正）。回傳方位角 0-360°（北=0 順時針）。
export function sunAzimuthAt(dateMs, lat, lon) {
  const d = new Date(dateMs);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - yearStart) / 86400000) + 1;
  const hourUtc = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;

  const g = (2 * Math.PI / 365) * (dayOfYear - 1 + (hourUtc - 12) / 24); // fractional year (rad)
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g)); // 分鐘
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g); // 赤緯（rad）

  const trueSolarMin = hourUtc * 60 + eqtime + 4 * lon; // 真太陽時（分鐘，UTC 基準）
  let haDeg = (trueSolarMin / 4 - 180) % 360;
  if (haDeg > 180) haDeg -= 360;
  if (haDeg < -180) haDeg += 360;
  const ha = haDeg * RAD;

  const latR = lat * RAD;
  const cosZen = clamp1(Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha));
  const sinZen = Math.sin(Math.acos(cosZen));
  if (sinZen < 1e-9) return 0; // 太陽在天頂，方位無定義

  const cosAz = clamp1((Math.sin(decl) - Math.sin(latR) * cosZen) / (Math.cos(latR) * sinZen));
  const az0 = Math.acos(cosAz) / RAD; // 0-180（東半邊）
  return ha > 0 ? 360 - az0 : az0; // 午後太陽在西半邊
}

const EARTH_R = 6371; // km

// 從 (lat, lon) 沿方位角 bearingDeg 走 distanceKm 的大圓終點。
export function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const delta = distanceKm / EARTH_R;
  const theta = bearingDeg * RAD;
  const lat1 = lat * RAD;
  const lat2 = Math.asin(clamp1(Math.sin(lat1) * Math.cos(delta) + Math.cos(lat1) * Math.sin(delta) * Math.cos(theta)));
  const lon2 = lon * RAD + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(lat1),
    Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2),
  );
  return { lat: lat2 / RAD, lon: ((lon2 / RAD + 540) % 360) - 180 };
}
