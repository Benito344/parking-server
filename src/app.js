'use strict';
const http = require('http');
const crypto = require('crypto');
const R = require('./rules');
const Z = require('./zones');
const { openClient, migrate, wrap } = require('./db');
const T = require('./telemetry');

async function createApp({
  adminToken = null, k = 5, dbPath = ':memory:', url, authToken,
  salt = crypto.randomBytes(16).toString('hex'), limits = R.DEFAULT_LIMITS,
  now = () => Date.now(), trustProxy = false,
} = {}) {
  const client = openClient({ url, authToken, dbPath });
  await migrate(client);
  const db = wrap(client);
  const pseudo = id => crypto.createHmac('sha256', salt).update(id).digest('hex').slice(0, 32);
  const rl = new R.RateLimiter(limits);

  async function aggregate() {
    const t = now(), avant = t - 86_400_000;
    const cells = new Map();
    const add = (kind, row, zone) => {
      if (!zone) return;
      const s = Z.slot(row.at), key = `${zone}|${s.dayType}|${s.hour}`;
      const c = cells.get(key) || { zone, dayType: s.dayType, hour: s.hour, departures: 0, fulls: 0, counts: 0, countedFree: 0, devices: new Set(), days: new Set(), rows: [] };
      c[kind]++; if (kind === 'counts') c.countedFree += row.free; c.devices.add(row.device); c.days.add(s.day); c.rows.push([kind, row.id]); cells.set(key, c);
    };
    for (const r of await db.all('SELECT id, lat, lon, device, created_at AS at FROM reports WHERE aggregated = 0 AND created_at < ?', [avant])) add('departures', r, Z.zoneOf(r.lat, r.lon));
    for (const f of await db.all('SELECT id, parking_id, device, at FROM fulls WHERE aggregated = 0 AND at < ?', [avant])) add('fulls', f, f.parking_id);
    for (const c of await db.all('SELECT id, zone, free, device, created_at AS at FROM counts WHERE aggregated = 0 AND created_at < ?', [avant])) add('counts', c, c.zone);
    let published = 0;
    const stmts = [];
    for (const c of cells.values()) {
      if (c.devices.size < k) continue;
      stmts.push([`INSERT INTO stats (zone, day_type, hour, departures, fulls, days, counts, counted_free) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(zone, day_type, hour) DO UPDATE SET departures = departures + excluded.departures, fulls = fulls + excluded.fulls, days = days + excluded.days,
          counts = counts + excluded.counts, counted_free = counted_free + excluded.counted_free`,
        [c.zone, c.dayType, c.hour, c.departures, c.fulls, c.days.size, c.counts, c.countedFree]]);
      for (const [kind, id] of c.rows) {
        const table = kind === 'departures' ? 'reports' : kind === 'fulls' ? 'fulls' : 'counts';
        stmts.push([`UPDATE ${table} SET aggregated = 1 WHERE id = ?`, [id]]);
      }
      published++;
    }
    if (stmts.length) await db.batch(stmts);
    return published;
  }

  async function purge() {
    await aggregate();
    await db.run('DELETE FROM problems WHERE at < ?', [now() - 30 * 86_400_000]);
    await db.run('DELETE FROM telemetry WHERE received_at < ? OR at < ?', [now() - T.RETENTION_MS, now() - T.RETENTION_MS]);   // rétention 90 jours
    const t = now(), cut = t - R.DETAIL_RETENTION_MS;
    const a = (await db.run('DELETE FROM reports WHERE created_at < ?', [cut])).changes;
    await db.run('DELETE FROM votes WHERE at < ? OR report_id NOT IN (SELECT id FROM reports)', [cut]);
    const b = (await db.run('DELETE FROM fulls WHERE at < ?', [cut])).changes
      + (await db.run('DELETE FROM counts WHERE created_at < ?', [cut])).changes;
    rl.sweep(t);
    return a + b;
  }

  async function state() {
    const t = now();
    const reports = await db.all('SELECT id,lat,lon,accuracy_class,source,created_at,confirmations FROM reports WHERE taken = 0 AND created_at > ? ORDER BY created_at', [t - R.REPORT_TTL_MS]);
    const fulls = await db.all('SELECT parking_id, MAX(at) AS at FROM fulls WHERE at > ? GROUP BY parking_id', [t - R.FULL_TTL_MS]);
    const counts = await db.all(`SELECT zone, free, free_disabled AS freeDisabled, created_at AS at FROM counts c WHERE created_at > ?
      AND created_at = (SELECT MAX(created_at) FROM counts WHERE zone = c.zone) GROUP BY zone ORDER BY zone`, [t - R.COUNT_TTL_MS]);
    return {
      now: t,
      reports: reports.map(r => ({ id: r.id, lat: r.lat, lon: r.lon, accuracy: r.accuracy_class, source: r.source, createdAt: r.created_at, confirmations: r.confirmations })),
      full: Object.fromEntries(fulls.map(f => [f.parking_id, f.at])),
      counts,
    };
  }

  const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(b); };

  async function readJson(req, max = 4096) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error('trop gros'), { code: 413 }); chunks.push(c); }
    try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { throw Object.assign(new Error('JSON invalide'), { code: 400 }); }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const ip = (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '?';
    // /health : léger (ni base, ni limiteur) — sondé par Render et par le keepalive.
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : '{"ok":true}');
    }
    if (!rl.allow('ip', ip, now())) return send(res, 429, { error: 'trop de requêtes' });

    if (req.method === 'GET' && url.pathname === '/v1/state') return send(res, 200, await state());
    if (req.method === 'GET' && url.pathname === '/v1/communes')
      return send(res, 200, { communes: require('./communes').COMMUNES.map(c => ({ insee: c.insee, nom: c.nom, bbox: c.bbox, centre: c.centre,
        zones: Z.ZONES.filter(z => require('./communes').communeOfZone(z.id) === c.insee).map(z => z.id), marches: c.marches || [] })) });

    if (req.method === 'GET' && url.pathname === '/v1/predictions/stats')
      return send(res, 200, { k, slot: 'heure locale Europe/Paris',
        cells: await db.all('SELECT zone, day_type AS dayType, hour, departures, fulls, days, counts, counted_free AS countedFree FROM stats') });
    const adminOk = () => {
      const h = String(req.headers.authorization || ''), tok = h.startsWith('Bearer ') ? h.slice(7) : '';
      const a = crypto.createHash('sha256').update(tok).digest(), b = crypto.createHash('sha256').update(adminToken).digest();
      return !!tok && crypto.timingSafeEqual(a, b);
    };
    if (req.method === 'GET' && url.pathname === '/v1/admin/telemetry') {
      if (!adminToken) return send(res, 404, { error: 'introuvable' });
      if (!adminOk()) return send(res, 401, { error: 'jeton invalide' });
      const jours = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 90);
      return send(res, 200, await T.aggregates(db, now() - jours * 86_400_000));
    }
    if (req.method === 'GET' && url.pathname === '/v1/admin/problems') {
      if (!adminToken) return send(res, 404, { error: 'introuvable' });
      if (!adminOk()) return send(res, 401, { error: 'jeton invalide' });
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      return send(res, 200, { problems: (await db.all('SELECT * FROM problems ORDER BY at DESC LIMIT ?', [limit])).map(p => ({ ...p, log: JSON.parse(p.log || '[]') })) });
    }

    if (req.method === 'DELETE' && url.pathname === '/v1/telemetry') {
      const d = req.headers['x-device-id'];
      if (typeof d !== 'string' || !R.UUID.test(d)) return send(res, 400, { error: 'X-Device-Id (UUID v4) requis' });
      if (!rl.allow('telemetryDelete', pseudo(d), now())) return send(res, 429, { error: 'limite atteinte' });
      const r = await db.run('DELETE FROM telemetry WHERE device = ?', [pseudo(d)]);
      return send(res, 200, { deleted: r.changes });
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'introuvable' });
    const body = await readJson(req, url.pathname === '/v1/problems' || url.pathname === '/v1/telemetry' ? 65_536 : 4096);
    const dev = req.headers['x-device-id'];
    if (typeof dev !== 'string' || !R.UUID.test(dev)) return send(res, 400, { error: 'X-Device-Id (UUID v4) requis' });
    const device = pseudo(dev);

    if (url.pathname === '/v1/telemetry') {
      const v = T.validate(body, now()); if (v.error) return send(res, 422, { error: v.error });
      if (!rl.allow('telemetry', device, now())) return send(res, 429, { error: 'limite de télémétrie atteinte' });
      const r = now();
      await db.batch(v.events.map(e => ['INSERT INTO telemetry (device, at, received_at, type, from_state, to_state, speed, accuracy, reason, perms, app_version, android, model, commune) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [device, e.at, r, e.type, e.from, e.to, e.speed, e.accuracy, e.reason, e.perms, v.app.version, v.app.android, v.app.model, v.app.commune]]));
      return send(res, 201, { accepted: v.events.length });
    }

    if (url.pathname === '/v1/reports') {
      const err = R.validateReport(body); if (err) return send(res, 422, { error: err });
      if (!rl.allow('report', device, now())) return send(res, 429, { error: 'limite de signalements atteinte' });
      const p = R.roundPosition(body.lat, body.lon);
      const id = crypto.randomUUID();
      await db.run('INSERT INTO reports (id,lat,lon,accuracy_class,source,created_at,device) VALUES (?,?,?,?,?,?,?)',
        [id, p.lat, p.lon, body.accuracy <= 15 ? 15 : 30, body.source, R.roundTime(now()), device]);
      return send(res, 201, { id, lat: p.lat, lon: p.lon });
    }
    let m = url.pathname.match(/^\/v1\/reports\/([0-9a-f-]{36})\/votes$/);
    if (m) {
      const r = await db.get('SELECT * FROM reports WHERE id = ?', [m[1]]);
      if (!r || r.taken || r.created_at < now() - R.REPORT_TTL_MS) return send(res, 404, { error: 'signalement expiré ou inconnu' });
      if (!['still_free', 'taken'].includes(body.vote)) return send(res, 422, { error: 'vote invalide' });
      if (r.device === device) return send(res, 403, { error: 'impossible de voter sur son propre signalement' });
      if (!rl.allow('vote', device, now())) return send(res, 429, { error: 'limite de votes atteinte' });
      const ins = await db.run('INSERT OR IGNORE INTO votes (report_id,device,vote,at) VALUES (?,?,?,?)', [r.id, device, body.vote, now()]);
      if (ins.changes === 0) return send(res, 409, { error: 'déjà voté' });
      if (body.vote === 'taken') await db.run('UPDATE reports SET taken = 1 WHERE id = ?', [r.id]);
      else await db.run('UPDATE reports SET confirmations = confirmations + 1 WHERE id = ?', [r.id]);
      return send(res, 200, { ok: true });
    }
    m = url.pathname.match(/^\/v1\/parkings\/([a-z0-9_]+)\/full$/);
    if (m) {
      if (!R.PARKINGS.includes(m[1])) return send(res, 404, { error: 'parking inconnu' });
      if (!rl.allow('full', device, now())) return send(res, 429, { error: 'limite atteinte' });
      await db.run('INSERT INTO fulls (parking_id,device,at) VALUES (?,?,?)', [m[1], device, R.roundTime(now())]);
      return send(res, 201, { ok: true });
    }
    if (url.pathname === '/v1/counts') {
      const err = R.validateCount(body); if (err) return send(res, 422, { error: err });
      const z = Z.ZONES.find(x => x.id === body.zone);
      if (!z) return send(res, 404, { error: 'lieu inconnu' });
      if (Z.dist(z, body) > R.COUNT_MAX_CENTROID_M) return send(res, 422, { error: 'trop loin du lieu pour compter' });
      if (!rl.allow('count', device, now())) return send(res, 429, { error: 'limite de comptages atteinte' });
      await db.run('INSERT INTO counts (zone, free, free_disabled, created_at, device) VALUES (?,?,?,?,?)',
        [z.id, body.free, body.freeDisabled ?? null, R.roundTime(now()), device]);
      return send(res, 201, { ok: true });
    }
    if (url.pathname === '/v1/problems') {
      const types = ['faux_depart', 'depart_manque', 'mauvais_stationnement', 'autre'];
      if (!types.includes(body.type)) return send(res, 422, { error: 'type invalide' });
      if (body.comment != null && (typeof body.comment !== 'string' || body.comment.length > 1000)) return send(res, 422, { error: 'commentaire trop long' });
      if (body.log != null && (!Array.isArray(body.log) || body.log.length > 500)) return send(res, 422, { error: 'journal invalide' });
      if (!rl.allow('problem', device, now())) return send(res, 429, { error: 'limite atteinte' });
      const num = (v, step) => Number.isFinite(v) ? Math.round(v / step) * step : null;
      const str = v => typeof v === 'string' ? v.slice(0, 40).replace(/[^A-Za-z_]/g, '') : null;
      const log = (body.log || []).map(e => ({ dt: num(e.dt, 1), evt: str(e.evt), from: str(e.from), to: str(e.to),
        vitesseKmh: num(e.vitesseKmh, 1), distanceM: num(e.distanceM, 10), precision: num(e.precision, 5) }));
      const id = crypto.randomUUID();
      await db.run('INSERT INTO problems (id, at, type, comment, app_version, log) VALUES (?,?,?,?,?,?)',
        [id, R.roundTime(now(), 60_000), body.type, body.comment || null,
          typeof body.appVersion === 'string' ? body.appVersion.slice(0, 20).replace(/[^0-9A-Za-z.-]/g, '') : null, JSON.stringify(log)]);
      return send(res, 201, { id });
    }
    return send(res, 404, { error: 'introuvable' });
  }

  const server = http.createServer((req, res) => handle(req, res).catch(e => send(res, e.code >= 400 && e.code < 500 ? e.code : 500, { error: e.code ? e.message : 'erreur serveur' })));
  return { server, db, purge, state, aggregate };
}
module.exports = { createApp };
