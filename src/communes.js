'use strict';
// Communes couvertes (config). Emprises = boîtes englobantes ; Lunel inchangée depuis la v0.2.
const COMMUNES = [
  { insee: '34145', nom: 'Lunel', bbox: { latMin: 43.640, latMax: 43.705, lonMin: 4.090, lonMax: 4.170 }, centre: { lat: 43.6737, lon: 4.1310 }, prefix: null },
  { insee: '34146', nom: 'Lunel-Viel', bbox: { latMin: 43.6577, latMax: 43.7028, lonMin: 4.0533, lonMax: 4.1109 }, centre: { lat: 43.6781299, lon: 4.0913697 }, prefix: 'lv_',
    // Source : ville-lunelviel.fr (Marché & commerces ambulants), consulté le 14/10/2026.
    marches: [{ nom: 'Marché hebdomadaire', lieu: 'place du 14 Juillet', jours: ['jeudi'], debut: '08:00', fin: '13:00' }] },
];
const inAny = (lat, lon) => COMMUNES.some(c => lat >= c.bbox.latMin && lat <= c.bbox.latMax && lon >= c.bbox.lonMin && lon <= c.bbox.lonMax);
const communeOfZone = id => (COMMUNES.find(c => c.prefix && id.startsWith(c.prefix)) || COMMUNES[0]).insee;
module.exports = { COMMUNES, inAny, communeOfZone };
