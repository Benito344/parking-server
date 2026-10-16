'use strict';
/**
 * Jeton d'administration (GET /v1/admin/problems et /v1/admin/telemetry).
 * Lit ADMIN_TOKEN_ALBERT (nom utilisé sur Render), puis en repli ADMIN_TOKEN. Valeur vide ou espaces = absente.
 * Renvoie { token, source } ; token null = lecture admin désactivée (404).
 */
function adminTokenDepuisEnv(env = process.env) {
  for (const nom of ['ADMIN_TOKEN_ALBERT', 'ADMIN_TOKEN']) {
    const v = typeof env[nom] === 'string' ? env[nom].trim() : '';
    if (v) return { token: v, source: nom };
  }
  return { token: null, source: null };
}
module.exports = { adminTokenDepuisEnv };
