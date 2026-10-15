'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');
const Z = require('../src/zones');
const C = require('../src/communes');
const R = require('../src/rules');

const ormeau = { lat: 43.9354647, lon: 3.708804 }; // parking du Plan de l'Ormeau (way 823910999)

test('Ganges : commune, lieux, emprise', () => {
  assert.deepStrictEqual(C.COMMUNES.map(c => c.insee), ['34145', '34146', '34111']);
  assert.ok(R.inZone(ormeau.lat, ormeau.lon)); assert.ok(!R.inZone(43.80, 3.90));
  assert.strictEqual(Z.zoneOf(ormeau.lat, ormeau.lon), 'ga_823910999');
  assert.strictEqual(C.communeOfZone('ga_823910999'), '34111');
  assert.strictEqual(Z.ZONES.filter(z => z.id.startsWith('ga_')).length, 38);
  assert.ok(R.PARKINGS.includes('ga_823910999'));
  assert.strictEqual(C.communeOfZone('esplanade'), '34145');
});

test('Ganges : signalement, plein, comptage et /v1/communes', async () => {
  const app = await createApp({ now: () => Date.parse('2026-10-15T18:00:00Z') });
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const dev = '44444444-4444-4444-8444-444444444444';
  const call = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-device-id': dev }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json() }; };
  try {
    assert.strictEqual((await call('POST', '/v1/reports', { lat: ormeau.lat, lon: ormeau.lon, accuracy: 8, source: 'MANUEL' })).status, 201);
    assert.strictEqual((await call('POST', '/v1/parkings/ga_823910999/full')).status, 201);
    assert.strictEqual((await call('POST', '/v1/counts', { zone: 'ga_823910999', free: 3, lat: ormeau.lat, lon: ormeau.lon, accuracy: 10 })).status, 201);
    const c = await call('GET', '/v1/communes');
    const g = c.body.communes.find(x => x.insee === '34111');
    assert.strictEqual(g.nom, 'Ganges'); assert.strictEqual(g.zones.length, 38); assert.strictEqual(g.marches.length, 2);
  } finally { await new Promise(r => app.server.close(r)); }
});
