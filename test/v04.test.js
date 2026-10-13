'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');
const Z = require('../src/zones');

const dev = i => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`;
async function setup(opts = {}) {
  let t = Date.parse('2026-10-15T08:10:00Z'); // jeudi 10 h 10 à Lunel
  const app = createApp({ now: () => t, ...opts });
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, d, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(d ? { 'x-device-id': d } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { app, call, add: ms => { t += ms; }, close: () => new Promise(r => app.server.close(r)) };
}
const canal = { lat: 43.67370, lon: 4.13174, accuracy: 8, source: 'MANUEL' };

test('zones et créneaux (heure de Paris)', () => {
  assert.strictEqual(Z.zoneOf(43.67370, 4.13174), 'canal');
  assert.strictEqual(Z.zoneOf(43.69, 4.10), null);
  assert.deepStrictEqual(Z.slot(Date.parse('2026-10-15T08:10:00Z')).hour, 10);
  assert.strictEqual(Z.slot(Date.parse('2026-10-18T08:00:00Z')).dayType, 'dimanche');
  assert.strictEqual(Z.slot(Date.parse('2026-10-17T08:00:00Z')).dayType, 'samedi');
});

test('agrégation : rien avant 24 h, rien sous 5 installations, publication à 5', async () => {
  const s = await setup();
  for (let i = 1; i <= 4; i++) await s.call('POST', '/v1/reports', dev(i), canal);
  await s.call('POST', '/v1/parkings/canal/full', dev(1));
  assert.strictEqual(s.app.aggregate(), 0); // < 24 h
  s.add(24 * 3600_000 + 60_000);
  assert.strictEqual(s.app.aggregate(), 0); // 4 installations < k
  assert.deepStrictEqual((await s.call('GET', '/v1/predictions/stats')).body.cells, []);
  // Le lendemain, même créneau (jeudi→vendredi = « ouvre », 10 h), une 5e installation : fusion.
  await s.call('POST', '/v1/reports', dev(5), canal);
  s.add(25 * 3600_000);
  assert.strictEqual(s.app.aggregate(), 1);
  const cells = (await s.call('GET', '/v1/predictions/stats')).body.cells;
  assert.deepStrictEqual(cells, [{ zone: 'canal', dayType: 'ouvre', hour: 10, departures: 5, fulls: 1, days: 2 }]);
  assert.ok(!JSON.stringify(cells).includes('1111')); // aucun identifiant
  assert.strictEqual(s.app.aggregate(), 0); // pas de double comptage
  await s.close();
});

test('lignes jamais agrégées supprimées à 7 jours', async () => {
  const s = await setup();
  await s.call('POST', '/v1/reports', dev(1), canal);
  s.add(8 * 86_400_000); s.app.purge();
  assert.strictEqual(s.app.db.prepare('SELECT COUNT(*) n FROM reports').get().n, 0);
  assert.strictEqual(s.app.db.prepare('SELECT COUNT(*) n FROM stats').get().n, 0);
  await s.close();
});

test('rapport de problème : liste blanche, pas de position ni identifiant', async () => {
  const s = await setup({ adminToken: 'secret-admin' });
  const log = [{ dt: -120.4, evt: 'Fixe', from: 'STATIONNE', to: 'DEPART_SUSPECT', vitesseKmh: 17.6, distanceM: 47, precision: 8, lat: 43.67, lon: 4.13, bt: 'AA:BB:CC:DD:EE:FF' }];
  const r = await s.call('POST', '/v1/problems', dev(1), { type: 'faux_depart', comment: 'Je suis resté garé', log, appVersion: '0.4.0-proto' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await s.call('POST', '/v1/problems', dev(1), { type: 'xx' })).status, 422);
  assert.strictEqual((await s.call('POST', '/v1/problems', null, { type: 'autre' })).status, 400);
  assert.strictEqual((await s.call('GET', '/v1/admin/problems')).status, 401);
  assert.strictEqual((await s.call('GET', '/v1/admin/problems', null, null, { authorization: 'Bearer faux' })).status, 401);
  const lu = await s.call('GET', '/v1/admin/problems', null, null, { authorization: 'Bearer secret-admin' });
  assert.strictEqual(lu.status, 200);
  const p = lu.body.problems[0];
  assert.strictEqual(p.type, 'faux_depart'); assert.strictEqual(p.app_version, '0.4.0-proto');
  assert.deepStrictEqual(p.log[0], { dt: -120, evt: 'Fixe', from: 'STATIONNE', to: 'DEPART_SUSPECT', vitesseKmh: 18, distanceM: 50, precision: 10 });
  assert.ok(!JSON.stringify(lu.body).match(/AA:BB|43\.67|1111/));
  await s.close();
});

test('lecture admin désactivée sans ADMIN_TOKEN', async () => {
  const s = await setup();
  assert.strictEqual((await s.call('GET', '/v1/admin/problems', null, null, { authorization: 'Bearer x' })).status, 404);
  await s.close();
});

test('rapports : limite 5/h et purge à 30 jours', async () => {
  const s = await setup({ adminToken: 't' });
  for (let i = 0; i < 5; i++) assert.strictEqual((await s.call('POST', '/v1/problems', dev(2), { type: 'autre' })).status, 201);
  assert.strictEqual((await s.call('POST', '/v1/problems', dev(2), { type: 'autre' })).status, 429);
  s.add(31 * 86_400_000); s.app.purge();
  assert.strictEqual(s.app.db.prepare('SELECT COUNT(*) n FROM problems').get().n, 0);
  await s.close();
});
