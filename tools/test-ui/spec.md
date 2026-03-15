# Test UI Spec

## Objectif

Fournir une interface web locale pour piloter les tests du plugin `sf-df` sans passer par le terminal.

L'interface doit permettre de:

1. Lancer les tests.
2. Suivre l'avancement en temps reel.
3. Voir le resultat final et les logs.
4. Annuler un test en cours.

## Portee

Tests cibles:

1. `e2e-local`
2. `e2e-org`

L'UI est un outil local de developpement (`tools/test-ui`), pas une feature du plugin publie.

## Exigences fonctionnelles

### 1) Lancer un test

L'utilisateur doit pouvoir demarrer:

1. Un run `e2e-local`
2. Un run `e2e-org`

Pour `e2e-org`, l'utilisateur doit pouvoir renseigner:

1. `targetOrg` (optionnel)
2. `devHubAlias` (optionnel)
3. `scratchDurationDays` (optionnel)
4. `keepOrg` (optionnel, booleen)

### 2) Suivre l'avancement

Pendant l'execution, l'interface doit afficher:

1. Le statut du run (`running`, `passed`, `failed`, `canceled`)
2. Les timestamps (`startedAt`, `endedAt`)
3. Les logs streames en temps reel
4. Un indicateur visuel "en cours"

### 3) Voir les resultats

A la fin d'un run, l'utilisateur doit voir:

1. Le statut final
2. Le code de sortie
3. La duree
4. Les logs complets

L'historique recent des runs doit rester consultable dans la session.

### 4) Annuler un test

L'utilisateur doit pouvoir annuler un run `running`.

Comportement attendu:

1. Le process de test est stoppe proprement.
2. Les sous-processus eventuels sont tues (important sur Windows).
3. Le run passe a l'etat `canceled`.
4. L'interface arrete d'afficher le run comme actif.

## Exigences backend (API)

API minimales:

1. `GET /api/health`
2. `GET /api/runs`
3. `POST /api/runs`
4. `GET /api/runs/:id`
5. `POST /api/runs/:id/cancel` (a ajouter pour l'annulation)

Modele de run minimal:

1. `id`
2. `suite`
3. `status`
4. `startedAt`
5. `endedAt`
6. `exitCode`
7. `targetOrg`
8. `logs`

## Exigences UX

1. Une seule commande de demarrage (`npm run test-ui`).
2. Feedback immediat au clic (disabled/loading).
3. Erreurs lisibles (message clair).
4. Rafraichissement auto (polling ou stream).
5. Interface utilisable desktop/mobile.

## Criteres d'acceptation

1. Je peux lancer `e2e-local` depuis l'UI et voir `running -> passed/failed`.
2. Je peux lancer `e2e-org` avec params et voir ses logs.
3. Je peux consulter un run termine dans l'historique.
4. Je peux annuler un run en cours et son statut devient `canceled`.
5. Apres `Ctrl+C` du launcher, les ports sont liberes et `npm run test-ui` redemarre proprement.

## Hors scope (pour l'instant)

1. Auth utilisateur
2. Persistance base de donnees (historique inter-session)
3. Multi-tenant / acces distant
