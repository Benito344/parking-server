'use strict';
// Règles métier pures (testables). Valeurs = hypothèses du cahier des charges.
const ZONE = { latMin: 43.640, latMax: 43.705, lonMin: 4.090, lonMax: 4.170 }; // Lunel (approx.)
const PARKINGS = require('./zones').PARKING_IDS;
const SOURCES = ['AUTO_BLUETOOTH', 'AUTO_ACTIVITE', 'MANUEL', 'MANUEL_INCERTAIN'];
const REPORT_TTL_MS = 15 * 60_000;      // 9.2 : expiration dure 15 min (flux actif)
const FULL_TTL_MS = 30 * 60_000;        // « parking plein » visible 30 min (hyp.)
const DETAIL_RETENTION_MS = 7 * 86_400_000; // RG-04 : détail 7 jours puis suppression (agrégation non implémentée)

// RG-02 : position arrondie à 5 m, horodatage arrondi à 30 s.
function roundPosition(lat, lon, stepM = 5) {
  const dLat = stepM / 111_320;
  const dLon = stepM / (111_320 * Math.cos(lat * Math.PI / 180));
  const r = (v, d) => Math.round(Math.round(v / d) * d * 1e6) / 1e6;
  return { lat: r(lat, dLat), lon: r(lon, dLon) };
}
const roundTime = (ms, step = 30_000) => Math.round(ms / step) * step;
const inZone = (lat, lon) => require('./communes').inAny(lat, lon); // union des communes couvertes
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateReport(b) {
  if (!b || typeof b !== 'object') return 'corps invalide';
  const { lat, lon, accuracy, source } = b;
  if (![lat, lon, accuracy].every(Number.isFinite)) return 'lat/lon/accuracy requis';
  if (accuracy > 30 || accuracy < 0) return 'précision > 30 m : non publiable';
  if (!inZone(lat, lon)) return 'hors zone ouverte (Lunel, Lunel-Viel)';
  if (!SOURCES.includes(source)) return 'source inconnue';
  return null;
}

// Comptages terrain : visibles 1 h, détail 7 jours comme les autres signalements.
const COUNT_TTL_MS = 60 * 60_000;
const COUNT_MAX_CENTROID_M = 600; // contrôle serveur large (grands parkings) ; l'appli exige ≤ 150 m du contour
function validateCount(b) {
  if (!b || typeof b !== 'object') return 'corps invalide';
  const { zone, free, freeDisabled, lat, lon, accuracy } = b;
  if (typeof zone !== 'string' || !/^[a-z0-9_]{1,40}$/.test(zone)) return 'lieu invalide';
  if (!Number.isInteger(free) || free < 0 || free > 2000) return 'nombre de places invalide';
  if (freeDisabled != null && (!Number.isInteger(freeDisabled) || freeDisabled < 0 || freeDisabled > free)) return 'places PMR invalides';
  if (![lat, lon, accuracy].every(Number.isFinite)) return 'lat/lon/accuracy requis';
  if (accuracy < 0 || accuracy > 50) return 'précision > 50 m : comptage refusé';
  if (!inZone(lat, lon)) return 'hors zone ouverte (Lunel, Lunel-Viel)';
  return null;
}

// Limiteur à fenêtre glissante en mémoire.
class RateLimiter {
  constructor(limits) { this.limits = limits; this.hits = new Map(); }
  allow(kind, key, now = Date.now()) {
    const lim = this.limits[kind]; if (!lim) return true;
    const k = kind + ':' + key; const arr = (this.hits.get(k) || []).filter(t => now - t < lim.windowMs);
    if (arr.length >= lim.max) { this.hits.set(k, arr); return false; }
    arr.push(now); this.hits.set(k, arr); return true;
  }
  sweep(now = Date.now()) { for (const [k, a] of this.hits) if (!a.some(t => now - t < 3_600_000)) this.hits.delete(k); }
}
const DEFAULT_LIMITS = {
  ip: { max: 120, windowMs: 60_000 },
  report: { max: 6, windowMs: 3_600_000 },
  vote: { max: 30, windowMs: 3_600_000 },
  full: { max: 10, windowMs: 3_600_000 },
  problem: { max: 5, windowMs: 3_600_000 },
  count: { max: 10, windowMs: 3_600_000 },
  telemetry: { max: 12, windowMs: 3_600_000 },
  telemetryDelete: { max: 5, windowMs: 3_600_000 },
};
module.exports = { COUNT_TTL_MS, COUNT_MAX_CENTROID_M, validateCount, ZONE, PARKINGS, SOURCES, REPORT_TTL_MS, FULL_TTL_MS, DETAIL_RETENTION_MS, roundPosition, roundTime, inZone, UUID, validateReport, RateLimiter, DEFAULT_LIMITS };
