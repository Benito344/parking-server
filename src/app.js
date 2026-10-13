'use strict';
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const R = require('./rules');
const Z = require('./zones');

function createApp({ adminToken = null, k = 5, dbPath = ':memory:', salt = crypto.randomBytes(16).toString('hex'), limits = R.DEFAULT_LIMITS, now = () => Date.now(), trustProxy = false } = {}) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL, accuracy_class INTEGER NOT NULL,
      source TEXT NOT NULL, created_at INTEGER NOT NULL, device TEXT NOT NULL, confirmations INTEGER NOT NULL DEFAULT 0, taken INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS reports_created ON reports(created_at);
    CREATE TABLE IF NOT EXISTS votes (report_id TEXT NOT NULL, device TEXT NOT NULL, vote TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (report_id, device));
    CREATE TABLE IF NOT EXISTS fulls (id INTEGER PRIMARY KEY AUTOINCREMENT, parking_id TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS stats (zone TEXT NOT NULL, day_type TEXT NOT NULL, hour INTEGER NOT NULL,
      departures INTEGER NOT NULL DEFAULT 0, fulls INTEGER NOT NULL DEFAULT 0, days INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (zone, day_type, hour));
    CREATE TABLE IF NOT EXISTS problems (id TEXT PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, comment TEXT, app_version TEXT, log TEXT);
  `);
  // Migration douce : colonne « agrégé » sur les tables de détail.
  for (const t of ['reports', 'fulls']) { try { db.exec(`ALTER TABLE ${t} ADD COLUMN aggregated INTEGER NOT NULL DEFAULT 0`); } catch {} }
  // Le serveur ne stocke qu'un hachage salé de l'identifiant d'installation (pseudonyme, non réversible sans le sel).
  const pseudo = id => crypto.createHmac('sha256', salt).update(id).digest('hex').slice(0, 32);
  const rl = new R.RateLimiter(limits);

  const q = {
    insReport: db.prepare('INSERT INTO reports (id,lat,lon,accuracy_class,source,created_at,device) VALUES (?,?,?,?,?,?,?)'),
    getReport: db.prepare('SELECT * FROM reports WHERE id = ?'),
    insVote: db.prepare('INSERT OR IGNORE INTO votes (report_id,device,vote,at) VALUES (?,?,?,?)'),
    confirm: db.prepare('UPDATE reports SET confirmations = confirmations + 1 WHERE id = ?'),
    take: db.prepare('UPDATE reports SET taken = 1 WHERE id = ?'),
    insFull: db.prepare('INSERT INTO fulls (parking_id,device,at) VALUES (?,?,?)'),
    active: db.prepare('SELECT id,lat,lon,accuracy_class,source,created_at,confirmations FROM reports WHERE taken = 0 AND created_at > ? ORDER BY created_at'),
    fulls: db.prepare('SELECT parking_id, MAX(at) AS at FROM fulls WHERE at > ? GROUP BY parking_id'),
    purgeReports: db.prepare('DELETE FROM reports WHERE created_at < ?'),
    purgeVotes: db.prepare('DELETE FROM votes WHERE at < ? OR report_id NOT IN (SELECT id FROM reports)'),
    purgeFulls: db.prepare('DELETE FROM fulls WHERE at < ?'),
  };

  /**
   * RG-04 : agrégation par zone × type de jour × heure des détails de plus de 24 h.
   * Une cellule n'est publiée que si elle réunit ≥ k installations distinctes ; sinon ses lignes attendent
   * d'être fusionnées avec de nouvelles (jusqu'à la purge à 7 jours, où elles disparaissent sans être comptées).
   */
  function aggregate() {
    const t = now(), avant = t - 86_400_000;
    const cells = new Map();
    const add = (kind, row, zone) => {
      if (!zone) return;
      const s = Z.slot(row.at), key = `${zone}|${s.dayType}|${s.hour}`;
      const c = cells.get(key) || { zone, dayType: s.dayType, hour: s.hour, departures: 0, fulls: 0, devices: new Set(), days: new Set(), rows: [] };
      c[kind]++; c.devices.add(row.device); c.days.add(s.day); c.rows.push([kind, row.id]); cells.set(key, c);
    };
    for (const r of db.prepare('SELECT id, lat, lon, device, created_at AS at FROM reports WHERE aggregated = 0 AND created_at < ?').all(avant)) add('departures', r, Z.zoneOf(r.lat, r.lon));
    for (const f of db.prepare('SELECT id, parking_id, device, at FROM fulls WHERE aggregated = 0 AND at < ?').all(avant)) add('fulls', f, f.parking_id);
    const up = db.prepare(`INSERT INTO stats (zone, day_type, hour, departures, fulls, days) VALUES (?,?,?,?,?,?)
      ON CONFLICT(zone, day_type, hour) DO UPDATE SET departures = departures + excluded.departures, fulls = fulls + excluded.fulls, days = days + excluded.days`);
    const markR = db.prepare('UPDATE reports SET aggregated = 1 WHERE id = ?'), markF = db.prepare('UPDATE fulls SET aggregated = 1 WHERE id = ?');
    let published = 0;
    db.transaction(() => {
      for (const c of cells.values()) {
        if (c.devices.size < k) continue;
        up.run(c.zone, c.dayType, c.hour, c.departures, c.fulls, c.days.size); published++;
        for (const [kind, id] of c.rows) (kind === 'departures' ? markR : markF).run(id);
      }
    })();
    return published;
  }

  function purge() {
    aggregate();
    db.prepare('DELETE FROM problems WHERE at < ?').run(now() - 30 * 86_400_000); // rapports : 30 jours
    const t = now();
    const a = q.purgeReports.run(t - R.DETAIL_RETENTION_MS).changes;
    q.purgeVotes.run(t - R.DETAIL_RETENTION_MS);
    const b = q.purgeFulls.run(t - R.DETAIL_RETENTION_MS).changes;
    rl.sweep(t);
    return a + b;
  }

  function state() {
    const t = now();
    return {
      now: t,
      reports: q.active.all(t - R.REPORT_TTL_MS).map(r => ({ id: r.id, lat: r.lat, lon: r.lon, accuracy: r.accuracy_class, source: r.source, createdAt: r.created_at, confirmations: r.confirmations })),
      full: Object.fromEntries(q.fulls.all(t - R.FULL_TTL_MS).map(f => [f.parking_id, f.at])),
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
    if (!rl.allow('ip', ip, now())) return send(res, 429, { error: 'trop de requêtes' });

    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/v1/state') return send(res, 200, state());

    if (req.method === 'GET' && url.pathname === '/v1/predictions/stats')
      return send(res, 200, { k, slot: 'heure locale Europe/Paris', cells: db.prepare('SELECT zone, day_type AS dayType, hour, departures, fulls, days FROM stats').all() });
    if (req.method === 'GET' && url.pathname === '/v1/admin/problems') {
      if (!adminToken) return send(res, 404, { error: 'introuvable' });
      const h = String(req.headers.authorization || ''), tok = h.startsWith('Bearer ') ? h.slice(7) : '';
      const a = crypto.createHash('sha256').update(tok).digest(), b = crypto.createHash('sha256').update(adminToken).digest();
      if (!tok || !crypto.timingSafeEqual(a, b)) return send(res, 401, { error: 'jeton invalide' });
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      return send(res, 200, { problems: db.prepare('SELECT * FROM problems ORDER BY at DESC LIMIT ?').all(limit).map(p => ({ ...p, log: JSON.parse(p.log || '[]') })) });
    }

    if (req.method !== 'POST') return send(res, 404, { error: 'introuvable' });
    const body = await readJson(req, url.pathname === '/v1/problems' ? 65_536 : 4096);
    const dev = req.headers['x-device-id'];
    if (typeof dev !== 'string' || !R.UUID.test(dev)) return send(res, 400, { error: 'X-Device-Id (UUID v4) requis' });
    const device = pseudo(dev);

    if (url.pathname === '/v1/reports') {
      const err = R.validateReport(body); if (err) return send(res, 422, { error: err });
      if (!rl.allow('report', device, now())) return send(res, 429, { error: 'limite de signalements atteinte' });
      const p = R.roundPosition(body.lat, body.lon);
      const id = crypto.randomUUID();
      q.insReport.run(id, p.lat, p.lon, body.accuracy <= 15 ? 15 : 30, body.source, R.roundTime(now()), device);
      return send(res, 201, { id, lat: p.lat, lon: p.lon });
    }
    let m = url.pathname.match(/^\/v1\/reports\/([0-9a-f-]{36})\/votes$/);
    if (m) {
      const r = q.getReport.get(m[1]);
      if (!r || r.taken || r.created_at < now() - R.REPORT_TTL_MS) return send(res, 404, { error: 'signalement expiré ou inconnu' });
      if (!['still_free', 'taken'].includes(body.vote)) return send(res, 422, { error: 'vote invalide' });
      if (r.device === device) return send(res, 403, { error: 'impossible de voter sur son propre signalement' });
      if (!rl.allow('vote', device, now())) return send(res, 429, { error: 'limite de votes atteinte' });
      if (q.insVote.run(r.id, device, body.vote, now()).changes === 0) return send(res, 409, { error: 'déjà voté' });
      if (body.vote === 'taken') q.take.run(r.id); else q.confirm.run(r.id);
      return send(res, 200, { ok: true });
    }
    m = url.pathname.match(/^\/v1\/parkings\/([a-z_]+)\/full$/);
    if (m) {
      if (!R.PARKINGS.includes(m[1])) return send(res, 404, { error: 'parking inconnu' });
      if (!rl.allow('full', device, now())) return send(res, 429, { error: 'limite atteinte' });
      q.insFull.run(m[1], device, R.roundTime(now()));
      return send(res, 201, { ok: true });
    }
    if (url.pathname === '/v1/problems') {
      const types = ['faux_depart', 'depart_manque', 'mauvais_stationnement', 'autre'];
      if (!types.includes(body.type)) return send(res, 422, { error: 'type invalide' });
      if (body.comment != null && (typeof body.comment !== 'string' || body.comment.length > 1000)) return send(res, 422, { error: 'commentaire trop long' });
      if (body.log != null && (!Array.isArray(body.log) || body.log.length > 500)) return send(res, 422, { error: 'journal invalide' });
      if (!rl.allow('problem', device, now())) return send(res, 429, { error: 'limite atteinte' });
      // Liste blanche : aucune position, aucun identifiant ne peut être stocké même si le client en envoie.
      const num = (v, step) => Number.isFinite(v) ? Math.round(v / step) * step : null;
      const str = v => typeof v === 'string' ? v.slice(0, 40).replace(/[^A-Za-z_]/g, '') : null;
      const log = (body.log || []).map(e => ({ dt: num(e.dt, 1), evt: str(e.evt), from: str(e.from), to: str(e.to),
        vitesseKmh: num(e.vitesseKmh, 1), distanceM: num(e.distanceM, 10), precision: num(e.precision, 5) }));
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO problems (id, at, type, comment, app_version, log) VALUES (?,?,?,?,?,?)')
        .run(id, R.roundTime(now(), 60_000), body.type, body.comment || null, typeof body.appVersion === 'string' ? body.appVersion.slice(0, 20).replace(/[^0-9A-Za-z.-]/g, '') : null, JSON.stringify(log));
      return send(res, 201, { id });
    }
    return send(res, 404, { error: 'introuvable' });
  }

  const server = http.createServer((req, res) => handle(req, res).catch(e => send(res, e.code >= 400 && e.code < 500 ? e.code : 500, { error: e.code ? e.message : 'erreur serveur' })));
  return { server, db, purge, state, aggregate };
}
module.exports = { createApp };
