'use strict';
const { createClient } = require('@libsql/client');

/**
 * Client libSQL : Turso distant si TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN), sinon fichier local / :memory: (dev, tests).
 * Tous les accès sont async.
 */
function openClient({ url, authToken, dbPath } = {}) {
  const remote = url || process.env.TURSO_DATABASE_URL;
  const token = authToken ?? process.env.TURSO_AUTH_TOKEN;
  if (remote) {
    if (!token) console.warn('TURSO_AUTH_TOKEN manquant : connexion Turso probablement refusée');
    return createClient({ url: remote, authToken: token });
  }
  // Local : :memory: ou file:… (pas de better-sqlite3).
  const path = dbPath ?? process.env.DB_PATH ?? ':memory:';
  const local = path === ':memory:' ? ':memory:' : (path.startsWith('file:') ? path : `file:${path}`);
  return createClient({ url: local });
}

async function migrate(client) {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL, accuracy_class INTEGER NOT NULL,
      source TEXT NOT NULL, created_at INTEGER NOT NULL, device TEXT NOT NULL,
      confirmations INTEGER NOT NULL DEFAULT 0, taken INTEGER NOT NULL DEFAULT 0,
      aggregated INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS reports_created ON reports(created_at);
    CREATE TABLE IF NOT EXISTS votes (
      report_id TEXT NOT NULL, device TEXT NOT NULL, vote TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (report_id, device));
    CREATE TABLE IF NOT EXISTS fulls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, parking_id TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL,
      aggregated INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS stats (
      zone TEXT NOT NULL, day_type TEXT NOT NULL, hour INTEGER NOT NULL,
      departures INTEGER NOT NULL DEFAULT 0, fulls INTEGER NOT NULL DEFAULT 0, days INTEGER NOT NULL DEFAULT 0,
      counts INTEGER NOT NULL DEFAULT 0, counted_free INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (zone, day_type, hour));
    CREATE TABLE IF NOT EXISTS counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, zone TEXT NOT NULL, free INTEGER NOT NULL, free_disabled INTEGER,
      created_at INTEGER NOT NULL, device TEXT NOT NULL, aggregated INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS counts_created ON counts(created_at);
    CREATE TABLE IF NOT EXISTS problems (
      id TEXT PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, comment TEXT, app_version TEXT, log TEXT);
  `);
  // Migrations douces (bases déjà déployées sans ces colonnes).
  for (const sql of [
    'ALTER TABLE reports ADD COLUMN aggregated INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE fulls ADD COLUMN aggregated INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE stats ADD COLUMN counts INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE stats ADD COLUMN counted_free INTEGER NOT NULL DEFAULT 0',
  ]) { try { await client.execute(sql); } catch { /* colonne déjà présente */ } }
}

/** Petite façade async pour les tests et le code métier. */
function wrap(client) {
  const run = async (sql, args = []) => {
    const r = await client.execute(args.length ? { sql, args } : sql);
    return { changes: Number(r.rowsAffected), lastInsertRowid: r.lastInsertRowid };
  };
  const all = async (sql, args = []) => (await client.execute(args.length ? { sql, args } : sql)).rows;
  const get = async (sql, args = []) => (await all(sql, args))[0];
  const batch = (stmts) => client.batch(stmts.map(([sql, args]) => ({ sql, args: args || [] })), 'write');
  return { client, run, all, get, batch, close: () => client.close() };
}

module.exports = { openClient, migrate, wrap };
