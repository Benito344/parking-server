'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');

const dev = i => `${String(i).padStart(8, '0')}-2222-4222-8222-222222222222`;
async function setup(opts = {}) {
  let t = Date.parse('2026-10-14T09:45:00Z'); // mercredi 11 h 45 à Lunel
  const app = await createApp({ now: () => t, ...opts });
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, d, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(d ? { 'x-device-id': d } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { app, call, add: ms => { t += ms; }, close: () => new Promise(r => app.server.close(r)) };
}
const esp = { zone: 'esplanade', free: 4, freeDisabled: 1, lat: 43.67370, lon: 4.12975, accuracy: 8 };

test('comptage : publié dans /v1/state sans position ni identifiant, puis expire après 1 h', async () => {
  const s = await setup();
  assert.strictEqual((await s.call('POST', '/v1/counts', dev(1), esp)).status, 201);
  let st = (await s.call('GET', '/v1/state')).body;
  assert.deepStrictEqual(st.counts.map(c => [c.zone, c.free, c.freeDisabled]), [['esplanade', 4, 1]]);
  assert.deepStrictEqual(Object.keys(st.counts[0]).sort(), ['at', 'free', 'freeDisabled', 'zone']);
  const row = await s.app.db.get('SELECT * FROM counts');
  assert.ok(!('lat' in row) && !('lon' in row)); assert.notStrictEqual(row.device, dev(1));
  s.add(5 * 60_000);
  await s.call('POST', '/v1/counts', dev(2), { ...esp, free: 2, freeDisabled: null });
  st = (await s.call('GET', '/v1/state')).body;
  assert.strictEqual(st.counts.length, 1); assert.strictEqual(st.counts[0].free, 2); // le plus récent remplace
  s.add(61 * 60_000);
  assert.deepStrictEqual((await s.call('GET', '/v1/state')).body.counts, []);
  await s.close();
});

test('comptage : validations et distance', async () => {
  const s = await setup();
  const bad = [{ ...esp, zone: 'inconnu' }, { ...esp, free: -1 }, { ...esp, free: 2.5 }, { ...esp, freeDisabled: 5 }, { ...esp, accuracy: 80 },
    { ...esp, lat: 43.69, lon: 4.13 }, { ...esp, lat: 48.85 }];
  const codes = [];
  for (const b of bad) codes.push((await s.call('POST', '/v1/counts', dev(1), b)).status);
  assert.deepStrictEqual(codes, [404, 422, 422, 422, 422, 422, 422]);
  assert.strictEqual((await s.call('POST', '/v1/counts', null, esp)).status, 400);
  await s.close();
});

test('comptage : limite anti-abus (10 par heure et par installation)', async () => {
  const s = await setup();
  for (let i = 0; i < 10; i++) assert.strictEqual((await s.call('POST', '/v1/counts', dev(3), esp)).status, 201);
  assert.strictEqual((await s.call('POST', '/v1/counts', dev(3), esp)).status, 429);
  assert.strictEqual((await s.call('POST', '/v1/counts', dev(4), esp)).status, 201);
  await s.close();
});

test('comptage : agrégé dans les statistiques avec k = 5, détail purgé à 7 jours', async () => {
  const s = await setup();
  for (let i = 0; i < 4; i++) await s.call('POST', '/v1/counts', dev(10 + i), esp);
  s.add(25 * 3_600_000); await s.app.purge();
  assert.deepStrictEqual((await s.call('GET', '/v1/predictions/stats')).body.cells, []); // 4 < k
  s.add(-25 * 3_600_000); await s.call('POST', '/v1/counts', dev(20), { ...esp, free: 8 }); s.add(25 * 3_600_000);
  await s.app.purge();
  const cells = (await s.call('GET', '/v1/predictions/stats')).body.cells;
  assert.deepStrictEqual(cells, [{ zone: 'esplanade', dayType: 'ouvre', hour: 11, departures: 0, fulls: 0, days: 1, counts: 5, countedFree: 24 }]);
  s.add(7 * 86_400_000); await s.app.purge();
  assert.strictEqual((await s.app.db.get('SELECT COUNT(*) n FROM counts')).n, 0);
  await s.close();
});
