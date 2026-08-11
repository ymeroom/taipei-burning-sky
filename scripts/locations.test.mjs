import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCATIONS, DEFAULT_LOCATION, locationById, locationsWithEvent } from './locations.mjs';

const KINDS = ['sunset', 'sunrise'];

test('四個地點，id 不重複', () => {
  assert.equal(LOCATIONS.length, 4);
  const ids = LOCATIONS.map(l => l.id);
  assert.equal(new Set(ids).size, 4, `id 重複：${ids}`);
});

test('DEFAULT_LOCATION 確實存在於 LOCATIONS', () => {
  assert.equal(DEFAULT_LOCATION, 'taipei');
  assert.ok(LOCATIONS.some(l => l.id === DEFAULT_LOCATION));
});

test('座標落在台灣範圍內', () => {
  for (const l of LOCATIONS) {
    assert.ok(l.lat >= 21.5 && l.lat <= 25.5, `${l.id} 緯度 ${l.lat} 不在台灣範圍`);
    assert.ok(l.lon >= 119.5 && l.lon <= 122.5, `${l.id} 經度 ${l.lon} 不在台灣範圍`);
  }
});

test('每個地點都有名稱與至少一個場次，場次鍵只能是 sunset/sunrise', () => {
  for (const l of LOCATIONS) {
    assert.ok(l.name && l.name.length > 0, `${l.id} 缺名稱`);
    const kinds = Object.keys(l.events);
    assert.ok(kinds.length >= 1, `${l.id} 沒有任何場次`);
    for (const k of kinds) assert.ok(KINDS.includes(k), `${l.id} 有非法場次 ${k}`);
  }
});

test('每個場次都有合法的鏡頭 id 與名稱，且鏡頭 id 全域不重複', () => {
  const cameras = [];
  for (const l of LOCATIONS) {
    for (const [kind, ev] of Object.entries(l.events)) {
      assert.match(ev.camera, /^[\w-]{11}$/, `${l.id}:${kind} 鏡頭 id 格式不對（${ev.camera}）`);
      assert.ok(ev.cameraName && ev.cameraName.length > 0, `${l.id}:${kind} 缺鏡頭名稱`);
      cameras.push(ev.camera);
    }
  }
  assert.equal(new Set(cameras).size, cameras.length, `鏡頭 id 重複：${cameras}`);
});

test('locationsWithEvent 回傳支援該場次的地點，順序同 LOCATIONS', () => {
  assert.deepEqual(locationsWithEvent('sunset').map(l => l.id), ['taipei', 'tamsui', 'gaomei']);
  assert.deepEqual(locationsWithEvent('sunrise').map(l => l.id), ['taipei', 'wanggaoliao']);
});

test('locationById 取得地點；未知 id 拋錯', () => {
  assert.equal(locationById('gaomei').lat, 24.3128);
  assert.equal(locationById('gaomei').name, '高美濕地');
  assert.equal(locationById('taipei').lon, 121.56);
  assert.throws(() => locationById('nope'), /locationById: 未知地點 nope/);
});

test('鏡頭對應正確（避免複製貼上把 id 貼錯地點）', () => {
  assert.equal(locationById('taipei').events.sunset.camera, 'z_fY1pj1VBw');
  assert.equal(locationById('taipei').events.sunrise.camera, 'xxMRjVwCQ3o');
  assert.equal(locationById('tamsui').events.sunset.camera, 'xwAWSh35uuw');
  assert.equal(locationById('gaomei').events.sunset.camera, 'fjhg3gAnMFg');
  assert.equal(locationById('wanggaoliao').events.sunrise.camera, 'lhXXhDyjFtI');
});

test('只宣告單一場次的地點確實沒有另一個場次', () => {
  assert.equal(locationById('gaomei').events.sunrise, undefined, '高美是西向夕陽點，不該有日出場');
  assert.equal(locationById('tamsui').events.sunrise, undefined);
  assert.equal(locationById('wanggaoliao').events.sunset, undefined);
});
