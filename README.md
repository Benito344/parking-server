# parking-server (prototype)
Node 20 + SQLite (better-sqlite3), API REST, rafraîchissement client toutes les 12 s.

- `npm ci && npm test` · `DEVICE_SALT=<secret> PORT=8080 npm start`
- Variables : `PORT`, `DB_PATH` (défaut data/parking.db), `DEVICE_SALT` (obligatoire en prod), `TRUST_PROXY=1` derrière un proxy (Render/Koyeb).
- API : `GET /health`, `GET /v1/state`, `POST /v1/reports`, `POST /v1/reports/:id/votes` {vote: still_free|taken}, `POST /v1/parkings/:id/full`. En-tête `X-Device-Id` (UUID v4 aléatoire) pour les POST.
- RGPD : position arrondie 5 m, heure arrondie 30 s, identifiant stocké en HMAC salé, flux actif 15 min, purge du détail à 7 jours (agrégation k=5 non implémentée).
- Les données sont éphémères par nature : sur un hébergement gratuit sans disque, une perte au redémarrage ne fait perdre que ≤ 15 min de signalements.
