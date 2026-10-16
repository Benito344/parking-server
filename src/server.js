'use strict';
const { createApp } = require('./app');
const { adminTokenDepuisEnv } = require('./config');
const admin = adminTokenDepuisEnv();
const port = Number(process.env.PORT || 8080);
if (!process.env.DEVICE_SALT) console.warn('DEVICE_SALT non défini : sel aléatoire (les pseudonymes changent à chaque redémarrage)');
if (!admin.token) console.warn('ADMIN_TOKEN_ALBERT / ADMIN_TOKEN non définis : lecture admin désactivée');
else console.log(`Jeton admin : ${admin.source}`);
if (process.env.TURSO_DATABASE_URL) console.log('Base : Turso', process.env.TURSO_DATABASE_URL.replace(/\/\/.*@/, '//***@'));
else console.log('Base : fichier local', process.env.DB_PATH || 'data/parking.db');

(async () => {
  const { server, purge } = await createApp({
    dbPath: process.env.DB_PATH || 'data/parking.db',
    ...(process.env.DEVICE_SALT ? { salt: process.env.DEVICE_SALT } : {}),
    trustProxy: process.env.TRUST_PROXY === '1',
    adminToken: admin.token,
  });
  setInterval(() => { purge().then(n => { if (n) console.log(`purge RGPD : ${n} lignes supprimées`); }).catch(e => console.error('purge', e)); }, 60_000).unref();
  await purge();
  server.listen(port, '0.0.0.0', () => console.log(`parking-server sur :${port}`));
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => server.close(() => process.exit(0)));
})().catch(e => { console.error(e); process.exit(1); });
