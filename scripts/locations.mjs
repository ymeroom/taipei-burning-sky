// 地點設定：全專案唯一的事實來源。座標、鏡頭 id 都只寫在這裡，其餘模組一律從此讀。
//
// 每個地點只宣告它實際適合的場次——高美濕地是西向夕陽點，替它產生日出分數只是噪音。
// 想新增地點或替既有地點補一個場次，改這個檔就好，其餘程式不需要改動。
//
// 座標經 Open-Meteo 驗證（2026-08-10）：海拔依序 10m／0m／0m／44m，
// 與實地相符（淡水與高美濱海、望高寮丘陵）。當日日落 18:33–18:35、日出 05:25–05:30。

export const LOCATIONS = [
  {
    id: 'taipei',
    name: '台北市中心',
    lat: 25.04,
    lon: 121.56,
    events: {
      sunset: { camera: 'z_fY1pj1VBw', cameraName: '象山看台北' },
      sunrise: { camera: 'xxMRjVwCQ3o', cameraName: '烘爐地' },
    },
  },
  {
    id: 'tamsui',
    name: '淡水漁人碼頭',
    lat: 25.1830,
    lon: 121.4103,
    events: {
      sunset: { camera: 'xwAWSh35uuw', cameraName: '淡水漁人碼頭' },
    },
  },
  {
    id: 'gaomei',
    name: '高美濕地',
    lat: 24.3128,
    lon: 120.5487,
    events: {
      sunset: { camera: 'fjhg3gAnMFg', cameraName: '高美濕地' },
    },
  },
  {
    id: 'wanggaoliao',
    name: '望高寮',
    lat: 24.1339,
    lon: 120.6194,
    events: {
      sunrise: { camera: 'lhXXhDyjFtI', cameraName: '望高寮' },
    },
  },
];

export const DEFAULT_LOCATION = 'taipei';

export function locationById(id) {
  const found = LOCATIONS.find(l => l.id === id);
  if (!found) throw new Error(`locationById: 未知地點 ${id}`);
  return found;
}

// 順序刻意沿用 LOCATIONS：批次請求的索引對照依賴這個順序的穩定性。
export function locationsWithEvent(kind) {
  return LOCATIONS.filter(l => l.events[kind]);
}
