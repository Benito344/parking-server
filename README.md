# parking-server (prototype)
Node 20 + **Turso / libSQL** (`@libsql/client`), API REST, rafraîchissement client toutes les 12 s.

- `npm ci && npm test` · `DEVICE_SALT=<secret> PORT=8080 npm start`
- Variables : `ADMIN_TOKEN_ALBERT` (jeton des routes `/v1/admin/*` ; repli : `ADMIN_TOKEN` ; les deux absents ou vides = routes admin désactivées, 404), `PORT`, `DEVICE_SALT` (obligatoire en prod), `TRUST_PROXY=1` derrière un proxy (Render/Koyeb), `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (prod) ou `DB_PATH` (fichier local / `:memory:` en dev).
- API : `GET /health`, `GET /v1/state`, `POST /v1/reports`, `POST /v1/reports/:id/votes` {vote: still_free|taken}, `POST /v1/parkings/:id/full`. En-tête `X-Device-Id` (UUID v4 aléatoire) pour les POST.
- RGPD : position arrondie 5 m, heure arrondie 30 s, identifiant stocké en HMAC salé, flux actif 15 min, purge du détail à 7 jours (agrégation k=5 non implémentée).
- En production : base **Turso** (persistante). Sans `TURSO_*`, fichier local `DB_PATH` (éphémère sur Render Free).

## v0.4 — prédictions et rapports
- `GET /v1/predictions/stats` : statistiques anonymes par zone × type de jour (ouvré/samedi/dimanche) × heure (Europe/Paris) : départs, « plein », nombre de jours. Agrégation des détails de plus de 24 h, publiée seulement si la cellule réunit ≥ 5 installations distinctes (sinon fusion avec les données suivantes, puis suppression à 7 jours). Aucun identifiant dans les stats.
- `POST /v1/problems` (X-Device-Id requis, 5/h) : `{type: faux_depart|depart_manque|mauvais_stationnement|autre, comment ≤ 1000, log ≤ 500 entrées, appVersion}`. Journal filtré par liste blanche (dt, evt, from, to, vitesseKmh, distanceM arrondie 10 m, precision) : toute position ou identifiant envoyé est ignoré. L'appareil n'est pas stocké. Conservation 30 jours.
- `GET /v1/admin/problems?limit=50` avec `Authorization: Bearer $ADMIN_TOKEN_ALBERT`.

## v0.5 : comptages terrain

`POST /v1/counts` (en-tête `X-Device-Id`) : `{ "zone": "esplanade", "free": 4, "freeDisabled": 1, "lat": …, "lon": …, "accuracy": 8 }`.
- Lieu connu (`zones.js`), `free` entier 0–2000, `freeDisabled` ≤ `free` (facultatif), précision ≤ 50 m, position dans Lunel et à moins de 600 m du centroïde du lieu
  (l'appli exige ≤ 150 m du contour réel). **La position sert uniquement à la vérification et n'est pas stockée.**
- Anti-abus : 10 comptages par heure et par installation (plus la limite par IP).
- `GET /v1/state` renvoie `counts` : dernier comptage par lieu sur 1 h (`zone`, `free`, `freeDisabled`, `at` arrondi à 30 s).
- Détail conservé 7 jours, puis agrégé dans `stats` (`counts`, `countedFree`) avec la même règle k = 5 installations distinctes.

## v0.6 : multi-communes (Lunel + Lunel-Viel)

- `src/communes.js` : configuration par commune (INSEE, nom, emprise, centre, préfixe des lieux, marchés). Lunel (34145) inchangée.
- Lunel-Viel (34146) : 19 lieux publics recensés sur OSM (`src/zones-lunel-viel.json`, identifiants `lv_<way>`), acceptés par `/v1/state`, `/v1/parkings/:id/full`, `/v1/counts` et les statistiques.
- Positions acceptées : union des emprises des communes.
- `GET /v1/communes` : liste des communes, de leurs lieux et marchés connus.

## Mise en veille Render Free : keepalive

`.github/workflows/keepalive.yml` appelle `/health` toutes les 10 min (curl avec 3 nouvelles tentatives, échec non bloquant).
- Quota : dépôt **public** (vérifié via l'API GitHub le 14/10/2026), donc minutes Actions gratuites et illimitées. S'il devenait privé : ≈ 4 320 exécutions par mois × 1 min facturée chacune ≈ 4 320 min, au-delà des 2 000 min gratuites ; il faudrait alors passer à un ping toutes les 25 min (≈ 1 730 min), ce qui ne suffirait plus à empêcher la mise en veille.
- Limites : cron GitHub parfois retardé de plusieurs minutes (la veille peut quand même survenir) ; workflows planifiés désactivés après 60 jours sans activité sur un dépôt public (les réactiver dans l'onglet Actions) ; 750 h d'instance gratuite par mois sur Render, assez pour **un seul** service toujours éveillé (744 h sur 31 jours).
- URL modifiable par la variable de dépôt `KEEPALIVE_URL`.
- Avec Turso configuré, les données survivent aux redéploiements et aux mises en veille. Sans Turso, le fichier local reste éphémère sur Render Free.


## Base Turso (production)

Si `TURSO_DATABASE_URL` et `TURSO_AUTH_TOKEN` sont définis, le serveur utilise Turso (libSQL distant). Sinon : fichier SQLite local (`DB_PATH`, défaut `data/parking.db`) pour le développement et les tests (`:memory:`).

### Offre gratuite Turso (vérifiée sur turso.tech/pricing, 14/10/2026)
- 100 bases, 5 Go de stockage, 500 millions de lignes lues / mois, 10 millions écrites / mois, 3 Go de sync.
- Pas de carte bancaire. Au-delà d'une limite : la base est **bloquée** jusqu'au mois suivant ou un passage au plan payant.
- Pas de mise en veille côté Turso (contrairement à Render Free).

### À faire une fois (Ben)

1. Ouvre [https://turso.tech](https://turso.tech) et connecte-toi (compte déjà créé).
2. Crée une base (bouton **Create Database** / **New Database**) :
   - Nom suggéré : `parking-lunel`.
   - **Région** : choisis une région **Europe**, de préférence proche de Render Frankfurt (ex. `aws-eu-central-1` / Frankfurt / `eu-central` selon l'interface). Si le tableau de bord propose seulement un « group », crée d'abord le group en UE, puis la base dedans.
   - Moteur : libSQL (défaut) ou Turso DB — les deux sont compatibles avec `@libsql/client`.
3. Sur la page de la base, copie l'**URL** (forme `libsql://parking-lunel-….turso.io`).
4. Crée un **jeton** d'accès :
   - Dans le tableau de bord : **Tokens** → **Create Token** (lecture + écriture, expiration « never » ou longue), **ou**
   - En ligne de commande : `turso db tokens create parking-lunel` ([doc](https://docs.turso.tech/sdk/authorization/tokens)).
5. Dans **Render** → service `parking-server` → **Environment** :
   - `TURSO_DATABASE_URL` = l'URL `libsql://…`
   - `TURSO_AUTH_TOKEN` = le jeton
   - (ne pas cocher « sync from blueprint » : ces variables sont `sync: false` dans `render.yaml`)
6. **Save** puis **Manual Deploy** (ou attends le prochain déploiement). Au démarrage, le serveur crée le schéma tout seul (idempotent) et journalise `Base : Turso libsql://…`.
7. Vérifie : `GET https://parking-server-eoua.onrender.com/health` puis un `GET /v1/state` après réveil. Les données restent après un redéploiement.

CLI (équivalent, doc Turso) :
```bash
turso auth login
turso group create parking --location aws-eu-central-1   # si besoin d'un group UE
turso db create parking-lunel --group parking
turso db show parking-lunel          # affiche l'URL
turso db tokens create parking-lunel # affiche le jeton
```

## v0.6.6 : télémétrie volontaire de la détection

Envoyée **uniquement si l'utilisateur a coché « Aider à améliorer l'appli »** (désactivé par défaut, révocable). Finalité : mesurer et corriger la détection automatique (trajets, arrivées, autorisations). Base légale : **consentement** (RGPD art. 6.1.a). Durée : **90 jours**, purge automatique.

- `POST /v1/telemetry` (en-tête `X-Device-Id`, 12 lots/h par installation, 64 Ko max) :
  `{ "app": { "version": "0.6.6-proto", "android": 36, "model": "SM-S921B", "commune": "34145" }, "events": [ { "t": 1760522160000, "type": "Fixe", "from": "VEILLE", "to": "EN_CONDUITE", "speedKmh": 32, "accuracyM": 20, "reason": "trajet : vitesse 32 km/h (calculée)", "perms": { "localisation": true, "toujours": true, "activite": true, "notifications": true, "batterie": false } } ] }`
  - Liste blanche stricte à tous les niveaux : un champ inconnu fait rejeter le lot (422).
  - Rejet de tout nom de champ évoquant une position (`lat`, `lon`, `lng`, `coord`, `geo`, `gps`, `position`, `domicile`, `home`, `adresse`, `trajet`…) et de toute valeur texte qui ressemble à une coordonnée (nombre à 4 décimales ou plus).
  - 1 à 200 événements ; types et états en liste blanche ; heure arrondie à la minute ; précision arrondie à 5 m ; vitesse à 1 km/h.
  - Identifiant stocké en HMAC salé (`DEVICE_SALT`), comme les comptages.
- `DELETE /v1/telemetry` (en-tête `X-Device-Id`) : supprime toutes les données de l'installation, renvoie `{ deleted }`.
- `GET /v1/admin/telemetry?days=30` (`Authorization: Bearer $ADMIN_TOKEN_ALBERT`, 1 à 90 jours) : agrégats seulement : événements, installations, trajets, arrivées détectées, taux d'arrivée, déclencheurs (vitesse, geofence, fin_activite, activite_vehicule, bluetooth), échecs par raison (chiffres masqués), répartition par modèle (installations, événements, versions d'Android).

## v0.6.7 : Ganges (INSEE 34111)

- `src/communes.js` : Ganges (34111, CP 34190, non contiguë à Lunel), emprise = bbox officielle geo.api.gouv.fr, centre = Plan de l'Ormeau, marchés du vendredi (7 h 30–14 h) et du mardi (7 h 30–13 h) autour des halles (sources : sudcevennes.com, jds.fr, illicomesproduitslocaux.fr, nosmarches.com).
- `src/zones-ganges.json` : 38 lieux publics (`ga_<way>`) recensés sur OSM le 15/10/2026 (contour officiel ; access=private/customers et nœuds sans contour exclus).
