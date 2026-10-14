'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');

test('/health léger : GET et HEAD, non soumis au limiteur par IP', async () => {
  const app = createApp({ limits: { ip: { max: 1, windowMs: 60_000 } } });
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(base + '/health'); assert.strictEqual(r.status, 200); assert.deepStrictEqual(await r.json(), { ok: true });
  }
  const h = await fetch(base + '/health', { method: 'HEAD' }); assert.strictEqual(h.status, 200);
  assert.strictEqual((await fetch(base + '/v1/state')).status, 200);
  assert.strictEqual((await fetch(base + '/v1/state')).status, 429); // le limiteur s'applique toujours au reste
  await new Promise(r => app.server.close(r));
});
