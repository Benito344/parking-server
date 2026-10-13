'use strict';
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const R = require('./rules');

function createApp({ dbPath = ':memory:', salt = crypto.randomBytes(16).toString('hex'), limits = R.DEFAULT_LIMITS, now = () => Date.now(), trustProxy = false } = {}) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL, accuracy_class INTEGER NOT NULL,
      source TEXT NOT NULL, created_at INTEGER NOT NULL, device TEXT NOT NULL, confirmations INTEGER NOT NULL DEFAULT 0, taken INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS reports_created ON reports(created_at);
    CREATE TABLE IF NOT EXISTS votes (report_id TEXT NOT NULL, device TEXT NOT NULL, vote TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (report_id, device));
    CREATE TABLE IF NOT EXISTS fulls (id INTEGER PRIMARY KEY AUTOINCREMENT, parking_id TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL);
  `);
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

  function purge() {
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

  async function readJson(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 4096) throw Object.assign(new Error('trop gros'), { code: 413 }); chunks.push(c); }
    try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { throw Object.assign(new Error('JSON invalide'), { code: 400 }); }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const ip = (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '?';
    if (!rl.allow('ip', ip, now())) return send(res, 429, { error: 'trop de requêtes' });

    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/v1/state') return send(res, 200, state());

    if (req.method !== 'POST') return send(res, 404, { error: 'introuvable' });
    const body = await readJson(req);
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
    return send(res, 404, { error: 'introuvable' });
  }

  const server = http.createServer((req, res) => handle(req, res).catch(e => send(res, e.code >= 400 && e.code < 500 ? e.code : 500, { error: e.code ? e.message : 'erreur serveur' })));
  return { server, db, purge, state };
}
module.exports = { createApp };
