'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');
const R = require('../src/rules');

const D1 = '11111111-1111-4111-8111-111111111111', D2 = '22222222-2222-4222-8222-222222222222', D3 = '33333333-3333-4333-8333-333333333333';
async function setup(opts = {}) {
  let t = Date.parse('2026-10-13T10:00:00Z'); const clock = { get: () => t, add: ms => { t += ms; } };
  const app = createApp({ now: clock.get, ...opts });
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, dev, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(dev ? { 'x-device-id': dev } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { app, clock, call, close: () => new Promise(r => app.server.close(r)) };
}
const rep = { lat: 43.6748711, lon: 4.1331429, accuracy: 10, source: 'MANUEL' };

test('arrondi position 5 m et horodatage 30 s', () => {
  const p = R.roundPosition(43.6748711, 4.1331429);
  assert.ok(Math.abs(p.lat - 43.6748711) * 111320 <= 2.6);
  assert.ok(Math.abs(p.lon - 4.1331429) * 111320 * Math.cos(43.67 * Math.PI / 180) <= 2.6);
  assert.strictEqual(R.roundTime(44_999), 30_000); assert.strictEqual(R.roundTime(45_000), 60_000);
});

test('signalement, visibilité partagée, expiration 15 min, purge 7 j', async () => {
  const s = await setup();
  const r = await s.call('POST', '/v1/reports', D1, rep); assert.strictEqual(r.status, 201);
  let st = (await s.call('GET', '/v1/state')).body; assert.strictEqual(st.reports.length, 1);
  assert.notStrictEqual(st.reports[0].lat, rep.lat); // arrondie
  assert.ok(!('device' in st.reports[0]));
  s.clock.add(16 * 60_000); st = (await s.call('GET', '/v1/state')).body; assert.strictEqual(st.reports.length, 0);
  assert.strictEqual(s.app.db.prepare('SELECT COUNT(*) n FROM reports').get().n, 1);
  s.clock.add(7 * 86_400_000); assert.strictEqual(s.app.purge(), 1);
  assert.strictEqual(s.app.db.prepare('SELECT COUNT(*) n FROM reports').get().n, 0);
  await s.close();
});

test('identifiant anonyme requis, stocké haché', async () => {
  const s = await setup();
  assert.strictEqual((await s.call('POST', '/v1/reports', null, rep)).status, 400);
  assert.strictEqual((await s.call('POST', '/v1/reports', 'toto', rep)).status, 400);
  await s.call('POST', '/v1/reports', D1, rep);
  const row = s.app.db.prepare('SELECT device FROM reports').get(); assert.ok(!row.device.includes('1111'));
  await s.close();
});

test('validation : précision, zone, source', async () => {
  const s = await setup();
  assert.strictEqual((await s.call('POST', '/v1/reports', D1, { ...rep, accuracy: 31 })).status, 422);
  assert.strictEqual((await s.call('POST', '/v1/reports', D1, { ...rep, lat: 43.61, lon: 3.87 })).status, 422);
  assert.strictEqual((await s.call('POST', '/v1/reports', D1, { ...rep, source: 'X' })).status, 422);
  await s.close();
});

test('votes : toujours libre, prise, pas sur soi, un seul par appareil', async () => {
  const s = await setup();
  const id = (await s.call('POST', '/v1/reports', D1, rep)).body.id;
  assert.strictEqual((await s.call('POST', `/v1/reports/${id}/votes`, D1, { vote: 'still_free' })).status, 403);
  assert.strictEqual((await s.call('POST', `/v1/reports/${id}/votes`, D2, { vote: 'still_free' })).status, 200);
  assert.strictEqual((await s.call('POST', `/v1/reports/${id}/votes`, D2, { vote: 'still_free' })).status, 409);
  assert.strictEqual((await s.call('GET', '/v1/state')).body.reports[0].confirmations, 1);
  assert.strictEqual((await s.call('POST', `/v1/reports/${id}/votes`, D3, { vote: 'taken' })).status, 200);
  assert.strictEqual((await s.call('GET', '/v1/state')).body.reports.length, 0);
  await s.close();
});

test('parking plein 30 min et parking inconnu', async () => {
  const s = await setup();
  assert.strictEqual((await s.call('POST', '/v1/parkings/canal/full', D1)).status, 201);
  assert.strictEqual((await s.call('POST', '/v1/parkings/xx/full', D1)).status, 404);
  assert.ok((await s.call('GET', '/v1/state')).body.full.canal);
  s.clock.add(31 * 60_000); assert.deepStrictEqual((await s.call('GET', '/v1/state')).body.full, {});
  await s.close();
});

test('anti-abus : limite de signalements par appareil et par IP', async () => {
  const s = await setup({ limits: { ...R.DEFAULT_LIMITS, ip: { max: 10, windowMs: 60_000 } } });
  for (let i = 0; i < 6; i++) assert.strictEqual((await s.call('POST', '/v1/reports', D1, rep)).status, 201);
  assert.strictEqual((await s.call('POST', '/v1/reports', D1, rep)).status, 429);
  for (let i = 0; i < 3; i++) await s.call('GET', '/v1/state');
  assert.strictEqual((await s.call('GET', '/v1/state')).status, 429);
  await s.close();
});

test('JSON invalide et corps trop gros', async () => {
  const s = await setup();
  const base = `http://127.0.0.1:${s.app.server.address().port}`;
  let r = await fetch(base + '/v1/reports', { method: 'POST', headers: { 'x-device-id': D1 }, body: '{' }); assert.strictEqual(r.status, 400);
  r = await fetch(base + '/v1/reports', { method: 'POST', headers: { 'x-device-id': D1 }, body: 'x'.repeat(5000) }); assert.strictEqual(r.status, 413);
  await s.close();
});
