'use strict';
// Zones de prédiction (centroïdes OSM via Nominatim, vérifiés le 13/10/2026). Identiques côté appli.
const ZONES = [
  { id: 'esplanade', lat: 43.6736690, lon: 4.1297437 },
  { id: 'canal', lat: 43.6736973, lon: 4.1317374 },
  { id: 'poste', lat: 43.6721900, lon: 4.1308698 },
  { id: 'joseph_blanc', lat: 43.6729692, lon: 4.1378397 },
  { id: 'pont_vesse', lat: 43.6767438, lon: 4.1385636 },
  { id: 'gare_sud', lat: 43.6788807, lon: 4.1263078 },
  { id: 'gare_nord', lat: 43.6800684, lon: 4.1314805 },
  { id: 'rue_gabriel_peri', lat: 43.6748711, lon: 4.1331429 },
  { id: 'rue_louis_rey', lat: 43.6748937, lon: 4.1342091 },
  { id: 'rue_baroncelli', lat: 43.6741793, lon: 4.1313357 },
].concat(require('./zones-osm.json')); // + recensement OSM complet des parkings publics de Lunel (13/10/2026)
const RAYON_M = 150;
function dist(a, b) {
  const r = 6371000, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}
function zoneOf(lat, lon) {
  let best = null, bd = Infinity;
  for (const z of ZONES) { const d = dist(z, { lat, lon }); if (d < bd) { bd = d; best = z.id; } }
  return bd <= RAYON_M ? best : null;
}
// Heure locale de Lunel (Europe/Paris) : type de jour et heure.
const fmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' });
function slot(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const wd = p.weekday.replace('.', '');
  const dayType = wd === 'sam' ? 'samedi' : wd === 'dim' ? 'dimanche' : 'ouvre';
  return { dayType, hour: Number(p.hour), day: `${p.year}-${p.month}-${p.day}`, weekday: wd };
}
const PARKING_IDS = ZONES.filter(z => !z.id.startsWith('rue_')).map(z => z.id);
module.exports = { PARKING_IDS, ZONES, zoneOf, slot, dist, RAYON_M };
