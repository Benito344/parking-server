'use strict';
/**
 * Télémétrie volontaire (consentement explicite dans l'appli, révocable).
 * Schéma strict en liste blanche : tout champ inconnu est refusé, et tout nom de champ ou valeur
 * qui ressemble à une coordonnée (lat/lon, « 43.67123 »…) fait rejeter le lot entier.
 */
const RETENTION_MS = 90 * 86_400_000;
const MAX_EVENTS = 200;
const TYPES = new Set(['VehiculeEntre', 'VehiculeSort', 'MarcheEntre', 'Immobile', 'FinActivite', 'SortieZone', 'Bluetooth', 'Fixe',
  'GeofenceEntree', 'Tick', 'GareManuel', 'OublierVoiture', 'Activer', 'Service', 'Autorisations', 'Transitions', 'TransitionRecue',
  'Vivant', 'Filet', 'Demarrage', 'Zone']);
const ETATS = new Set(['INACTIF', 'VEILLE', 'EN_CONDUITE', 'ARRET_CANDIDAT', 'STATIONNE', 'DEPART_SUSPECT']);
const COMMUNES = new Set(['34145', '34146']);
const PERMS = ['localisation', 'toujours', 'activite', 'notifications', 'batterie'];
const CHAMPS_APP = new Set(['version', 'android', 'model', 'commune']);
const CHAMPS_EVT = new Set(['t', 'type', 'from', 'to', 'speedKmh', 'accuracyM', 'reason', 'perms']);
const NOM_INTERDIT = /lat|lon|lng|coord|geo|gps|position|^pos|domicile|home|adress|address|trajet|route|track/i;
const VALEUR_COORD = /-?\b\d{1,3}[.,]\d{4,}\b/;   // 4 décimales ou plus : allure de coordonnée

function interdits(o, chemin = '') {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
    if (!Array.isArray(o) && NOM_INTERDIT.test(k)) return `champ interdit : ${chemin}${k}`;
    const r = interdits(v, `${chemin}${k}.`); if (r) return r;
  } else if (typeof o === 'string' && VALEUR_COORD.test(o)) return `valeur ressemblant à une coordonnée : ${chemin.slice(0, -1)}`;
  return null;
}
const inconnus = (o, autorises) => Object.keys(o).filter(k => !autorises.has(k));
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Renvoie { error } ou { app, events } normalisés. */
function validate(body, now) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'objet attendu' };
  const i = interdits(body); if (i) return { error: i };
  const top = inconnus(body, new Set(['app', 'events'])); if (top.length) return { error: `champ inconnu : ${top[0]}` };
  const a = body.app;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { error: 'app requis' };
  const ia = inconnus(a, CHAMPS_APP); if (ia.length) return { error: `champ inconnu : app.${ia[0]}` };
  if (typeof a.version !== 'string' || !/^[0-9A-Za-z.-]{1,20}$/.test(a.version)) return { error: 'app.version invalide' };
  if (!Number.isInteger(a.android) || a.android < 21 || a.android > 99) return { error: 'app.android invalide' };
  if (typeof a.model !== 'string' || !/^[0-9A-Za-z ._()+-]{1,40}$/.test(a.model)) return { error: 'app.model invalide' };
  if (a.commune != null && !COMMUNES.has(a.commune)) return { error: 'app.commune invalide' };
  if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_EVENTS) return { error: `events : 1 à ${MAX_EVENTS}` };
  const events = [];
  for (const [n, e] of body.events.entries()) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { error: `events[${n}] invalide` };
    const ie = inconnus(e, CHAMPS_EVT); if (ie.length) return { error: `champ inconnu : events[${n}].${ie[0]}` };
    if (!isNum(e.t, now - RETENTION_MS, now + 600_000)) return { error: `events[${n}].t invalide` };
    if (!TYPES.has(e.type)) return { error: `events[${n}].type inconnu` };
    for (const k of ['from', 'to']) if (e[k] != null && !ETATS.has(e[k])) return { error: `events[${n}].${k} invalide` };
    if (e.speedKmh != null && !isNum(e.speedKmh, 0, 400)) return { error: `events[${n}].speedKmh invalide` };
    if (e.accuracyM != null && !isNum(e.accuracyM, 0, 10_000)) return { error: `events[${n}].accuracyM invalide` };
    if (e.reason != null && (typeof e.reason !== 'string' || e.reason.length > 200)) return { error: `events[${n}].reason invalide` };
    let perms = null;
    if (e.perms != null) {
      if (typeof e.perms !== 'object' || Array.isArray(e.perms)) return { error: `events[${n}].perms invalide` };
      const ip = inconnus(e.perms, new Set(PERMS)); if (ip.length) return { error: `champ inconnu : events[${n}].perms.${ip[0]}` };
      if (Object.values(e.perms).some(v => typeof v !== 'boolean')) return { error: `events[${n}].perms : booléens attendus` };
      perms = JSON.stringify(e.perms);
    }
    events.push({ at: Math.round(e.t / 60_000) * 60_000, type: e.type, from: e.from ?? null, to: e.to ?? null,
      speed: e.speedKmh == null ? null : Math.round(e.speedKmh), accuracy: e.accuracyM == null ? null : Math.round(e.accuracyM / 5) * 5,
      reason: e.reason == null ? null : e.reason.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200), perms });
  }
  return { app: { version: a.version, android: a.android, model: a.model, commune: a.commune ?? null }, events };
}

function declencheur(reason) {
  const r = String(reason || '');
  if (/IN_VEHICLE/.test(r)) return 'activite_vehicule';
  if (/Bluetooth/i.test(r)) return 'bluetooth';
  if (/sortie de zone/.test(r)) return 'geofence';
  if (/fin de marche/.test(r)) return 'fin_activite';
  if (/vitesse/.test(r)) return 'vitesse';
  return 'autre';
}
const motif = r => String(r || 'sans raison').replace(/\d+/g, '#').split(' · ')[0].slice(0, 80);

async function aggregates(db, since) {
  const rows = await db.all('SELECT device, type, from_state AS f, to_state AS t, reason, model, android FROM telemetry WHERE at >= ?', [since]);
  const trajets = rows.filter(r => r.t === 'EN_CONDUITE' && (r.f === 'VEILLE' || r.f === 'STATIONNE'));
  const arrivees = rows.filter(r => r.t === 'STATIONNE' && r.f === 'ARRET_CANDIDAT');
  const echecs = rows.filter(r => (r.t === 'VEILLE' && (r.f === 'EN_CONDUITE' || r.f === 'ARRET_CANDIDAT')) ||
    (['Service', 'Transitions', 'Zone'].includes(r.type) && /refus|échec|non /.test(r.reason || '')));
  const compter = (l, f) => l.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const modeles = {};
  for (const r of rows) { const k = r.model; modeles[k] ||= { devices: new Set(), events: 0, android: new Set() }; modeles[k].devices.add(r.device); modeles[k].events++; modeles[k].android.add(r.android); }
  return {
    since, events: rows.length, devices: new Set(rows.map(r => r.device)).size,
    trips: trajets.length, arrivalsDetected: arrivees.length,
    arrivalRate: trajets.length ? Math.round(arrivees.length / trajets.length * 1000) / 1000 : null,
    triggers: compter(trajets, r => declencheur(r.reason)),
    failuresByReason: compter(echecs, r => motif(r.reason)),
    byModel: Object.fromEntries(Object.entries(modeles).map(([k, v]) => [k, { devices: v.devices.size, events: v.events, android: [...v.android].sort() }])),
  };
}

module.exports = { validate, aggregates, declencheur, RETENTION_MS, MAX_EVENTS, TYPES };
