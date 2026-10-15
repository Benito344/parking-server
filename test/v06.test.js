'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');
const Z = require('../src/zones');
const C = require('../src/communes');
const R = require('../src/rules');

const dev = i => `${String(i).padStart(8, '0')}-3333-4333-8333-333333333333`;
async function setup() {
  let t = Date.parse('2026-10-14T08:00:00Z'); // mercredi 10 h à Lunel-Viel
  const app = await createApp({ now: () => t });
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, d, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(d ? { 'x-device-id': d } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { app, call, add: ms => { t += ms; }, close: () => new Promise(r => app.server.close(r)) };
}
const place14 = { lat: 43.67811, lon: 4.09139 }; // parking de la place du 14 Juillet (way 889339755)

test('communes : Lunel inchangée, Lunel-Viel ajoutée', () => {
  assert.deepStrictEqual(C.COMMUNES.map(c => c.insee).slice(0, 2), ['34145', '34146']);
  assert.ok(R.inZone(43.6737, 4.1310)); assert.ok(R.inZone(place14.lat, place14.lon)); assert.ok(!R.inZone(43.61, 3.88));
  assert.strictEqual(Z.zoneOf(43.67370, 4.13174), 'canal');
  assert.strictEqual(Z.zoneOf(place14.lat, place14.lon), 'lv_889339755');
  assert.ok(R.PARKINGS.includes('lv_889339755') && R.PARKINGS.includes('esplanade'));
  assert.strictEqual(C.communeOfZone('lv_890785254'), '34146'); assert.strictEqual(C.communeOfZone('osm_142454915'), '34145');
});

test('GET /v1/communes', async () => {
  const s = await setup();
  const b = (await s.call('GET', '/v1/communes')).body;
  const lv = b.communes.find(c => c.insee === '34146');
  assert.strictEqual(lv.nom, 'Lunel-Viel'); assert.ok(lv.zones.length >= 15 && lv.zones.every(z => z.startsWith('lv_')));
  assert.strictEqual(lv.marches[0].lieu, 'place du 14 Juillet');
  assert.ok(b.communes[0].zones.includes('esplanade'));
  await s.close();
});

test('Lunel-Viel : signalement, plein, comptage, état et statistiques', async () => {
  const s = await setup();
  assert.strictEqual((await s.call('POST', '/v1/reports', dev(1), { ...place14, accuracy: 8, source: 'MANUEL' })).status, 201);
  assert.strictEqual((await s.call('POST', '/v1/parkings/lv_889339755/full', dev(1), {})).status, 201);
  assert.strictEqual((await s.call('POST', '/v1/counts', dev(1), { zone: 'lv_889339755', free: 3, freeDisabled: 1, ...place14, accuracy: 8 })).status, 201);
  // Comptage d'un lieu de Lunel-Viel depuis le centre de Lunel : refusé (trop loin).
  assert.strictEqual((await s.call('POST', '/v1/counts', dev(2), { zone: 'lv_889339755', free: 3, lat: 43.6737, lon: 4.1310, accuracy: 8 })).status, 422);
  const st = (await s.call('GET', '/v1/state')).body;
  assert.strictEqual(st.reports.length, 1); assert.ok(st.full.lv_889339755); assert.strictEqual(st.counts[0].zone, 'lv_889339755');
  for (let i = 2; i <= 5; i++) await s.call('POST', '/v1/counts', dev(i), { zone: 'lv_889339755', free: 5, ...place14, accuracy: 8 });
  s.add(25 * 3_600_000); await s.app.purge();
  const cell = (await s.call('GET', '/v1/predictions/stats')).body.cells.find(c => c.zone === 'lv_889339755');
  assert.strictEqual(cell.counts, 5); assert.strictEqual(cell.countedFree, 23);
  await s.close();
});
