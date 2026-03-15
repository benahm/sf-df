# Test UI

Interface web pour piloter les tests du plugin (`e2e-local` et `e2e-org`) et consulter les logs d'execution.

## Lancement (dev)

1. Installer les deps frontend:

```bash
npm --prefix tools/test-ui/web install
```

2. Lancer l'UI (API + frontend):

```bash
npm run test-ui
```

3. Ouvrir:

```text
http://127.0.0.1:5174
```

## Lancement (build)

```bash
npm run test-ui:build
node tools/test-ui/server/index.mjs
```

Puis ouvrir:

```text
http://127.0.0.1:8787
```

## API

- `GET /api/health`
- `GET /api/runs`
- `POST /api/runs` body:
  - `{ "suite": "e2e-local" }`
  - `{ "suite": "e2e-org", "targetOrg": "devorg-scratch-1d", "devHubAlias": "DevOrg", "scratchDurationDays": "1", "keepOrg": false }`
- `GET /api/runs/:id`
