'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');

const D1 = '11111111-1111-4111-8111-111111111111', D2 = '22222222-2222-4222-8222-222222222222';
async function setup() {
  let t = Date.parse('2026-10-15T10:00:00Z');
  const app = await createApp({ now: () => t, adminToken: 'secret' });
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, d, body, auth) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(d ? { 'x-device-id': d } : {}), ...(auth ? { authorization: auth } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { app, call, now: () => t, add: ms => { t += ms; }, close: () => new Promise(r => app.server.close(r)) };
}
const appInfo = { version: '0.6.6-proto', android: 36, model: 'SM-S921B', commune: '34145' };
const lot = t => ({ app: appInfo, events: [
  { t, type: 'Fixe', from: 'VEILLE', to: 'EN_CONDUITE', speedKmh: 32.4, accuracyM: 21, reason: 'trajet : vitesse 32 km/h (calculée)' },
  { t: t + 60_000, type: 'Tick', from: 'ARRET_CANDIDAT', to: 'STATIONNE', reason: 'garé : sortie du véhicule puis 60 s sans repartir · ±8 m' },
  { t: t + 120_000, type: 'Autorisations', from: 'STATIONNE', to: 'STATIONNE', perms: { localisation: true, toujours: true, activite: true, notifications: true, batterie: false } },
] });

test('télémétrie : acceptée, agrégée, supprimable', async () => {
  const s = await setup();
  try {
    assert.strictEqual((await s.call('POST', '/v1/telemetry', D1, lot(s.now() - 600_000))).status, 201);
    const b = lot(s.now() - 300_000); b.events[0].reason = 'trajet : sortie de zone (180 m)'; b.events.pop(); b.events.pop();
    b.events.push({ t: s.now() - 200_000, type: 'Tick', from: 'EN_CONDUITE', to: 'VEILLE', reason: 'faux trajet : jamais > 15 km/h' });
    assert.strictEqual((await s.call('POST', '/v1/telemetry', D2, { ...b, app: { ...appInfo, model: 'Pixel 8' } })).status, 201);
    const row = await s.app.db.get('SELECT * FROM telemetry ORDER BY id LIMIT 1');
    assert.strictEqual(row.at % 60_000, 0); assert.notStrictEqual(row.device, D1); assert.strictEqual(row.speed, 32); assert.strictEqual(row.accuracy, 20);
    assert.strictEqual((await s.call('GET', '/v1/admin/telemetry')).status, 401);
    const g = await s.call('GET', '/v1/admin/telemetry?days=7', null, null, 'Bearer secret');
    assert.strictEqual(g.status, 200);
    assert.strictEqual(g.body.trips, 2); assert.strictEqual(g.body.arrivalsDetected, 1); assert.strictEqual(g.body.arrivalRate, 0.5);
    assert.deepStrictEqual(g.body.triggers, { vitesse: 1, geofence: 1 });
    assert.strictEqual(g.body.failuresByReason['faux trajet : jamais > # km/h'], 1);
    assert.strictEqual(g.body.byModel['SM-S921B'].devices, 1); assert.deepStrictEqual(g.body.byModel['Pixel 8'].android, [36]);
    const del = await s.call('DELETE', '/v1/telemetry', D1);
    assert.strictEqual(del.status, 200); assert.strictEqual(del.body.deleted, 3);
    assert.strictEqual((await s.app.db.get('SELECT COUNT(*) AS n FROM telemetry')).n, 2);
  } finally { await s.close(); }
});

test('télémétrie : schéma strict, aucune coordonnée', async () => {
  const s = await setup();
  try {
    const t = s.now() - 60_000;
    const cas = [
      [{ ...lot(t), extra: 1 }, /champ inconnu/],
      [{ app: { ...appInfo, latitude: 43.67 }, events: lot(t).events }, /interdit/],
      [{ app: appInfo, events: [{ t, type: 'Fixe', lat: 43.6712, lon: 4.1301 }] }, /interdit/],
      [{ app: appInfo, events: [{ t, type: 'Fixe', position: 'x' }] }, /interdit/],
      [{ app: appInfo, events: [{ t, type: 'Fixe', domicile: true }] }, /interdit/],
      [{ app: appInfo, events: [{ t, type: 'Fixe', reason: 'garé en 43.67123, 4.13012' }] }, /coordonnée/],
      [{ app: appInfo, events: [{ t, type: 'Fixe', distanceM: 40 }] }, /champ inconnu/],
      [{ app: appInfo, events: [{ t, type: 'Inconnu' }] }, /type/],
      [{ app: appInfo, events: [{ t, type: 'Fixe', perms: { localisation: true, gps: true } }] }, /interdit|inconnu/],
      [{ app: appInfo, events: [] }, /events/],
      [{ app: { ...appInfo, commune: '75056' }, events: lot(t).events }, /commune/],
    ];
    for (const [body, re] of cas) { const r = await s.call('POST', '/v1/telemetry', D1, body); assert.strictEqual(r.status, 422, JSON.stringify(body)); assert.match(r.body.error, re); }
    assert.strictEqual((await s.app.db.get('SELECT COUNT(*) AS n FROM telemetry')).n, 0);
  } finally { await s.close(); }
});

test('télémétrie : limite de débit et rétention 90 jours', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 12; i++) assert.strictEqual((await s.call('POST', '/v1/telemetry', D1, lot(s.now() - 60_000))).status, 201);
    assert.strictEqual((await s.call('POST', '/v1/telemetry', D1, lot(s.now() - 60_000))).status, 429);
    s.add(91 * 86_400_000); await s.app.purge();
    assert.strictEqual((await s.app.db.get('SELECT COUNT(*) AS n FROM telemetry')).n, 0);
  } finally { await s.close(); }
});
