# parking-server (prototype)
Node 20 + SQLite (better-sqlite3), API REST, rafraîchissement client toutes les 12 s.

- `npm ci && npm test` · `DEVICE_SALT=<secret> PORT=8080 npm start`
- Variables : `ADMIN_TOKEN` (lecture des rapports ; absent = désactivé), `PORT`, `DB_PATH` (défaut data/parking.db), `DEVICE_SALT` (obligatoire en prod), `TRUST_PROXY=1` derrière un proxy (Render/Koyeb).
- API : `GET /health`, `GET /v1/state`, `POST /v1/reports`, `POST /v1/reports/:id/votes` {vote: still_free|taken}, `POST /v1/parkings/:id/full`. En-tête `X-Device-Id` (UUID v4 aléatoire) pour les POST.
- RGPD : position arrondie 5 m, heure arrondie 30 s, identifiant stocké en HMAC salé, flux actif 15 min, purge du détail à 7 jours (agrégation k=5 non implémentée).
- Les données sont éphémères par nature : sur un hébergement gratuit sans disque, une perte au redémarrage ne fait perdre que ≤ 15 min de signalements.

## v0.4 — prédictions et rapports
- `GET /v1/predictions/stats` : statistiques anonymes par zone × type de jour (ouvré/samedi/dimanche) × heure (Europe/Paris) : départs, « plein », nombre de jours. Agrégation des détails de plus de 24 h, publiée seulement si la cellule réunit ≥ 5 installations distinctes (sinon fusion avec les données suivantes, puis suppression à 7 jours). Aucun identifiant dans les stats.
- `POST /v1/problems` (X-Device-Id requis, 5/h) : `{type: faux_depart|depart_manque|mauvais_stationnement|autre, comment ≤ 1000, log ≤ 500 entrées, appVersion}`. Journal filtré par liste blanche (dt, evt, from, to, vitesseKmh, distanceM arrondie 10 m, precision) : toute position ou identifiant envoyé est ignoré. L'appareil n'est pas stocké. Conservation 30 jours.
- `GET /v1/admin/problems?limit=50` avec `Authorization: Bearer $ADMIN_TOKEN`.
