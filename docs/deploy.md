# `sf df deploy`

Commande : [`src/commands/df/deploy.ts`](../src/commands/df/deploy.ts). Moteur : [`src/deploy/`](../src/deploy/).

Merge une branche dans la branche d'une org, déploie le résultat sur l'org, et ne pousse le merge que si le
déploiement a réussi.

```bash
sf df deploy --source feature/JIRA-123 --target-org int
```

## Une branche = une org

La branche d'une org **est** son état : son dernier commit est exactement ce qui est déployé. Pas de tag, pas
d'enregistrement dans l'org.

Condition : **seul `sf df deploy` pousse sur cette branche.** Une protection de branche dans la forge l'impose (seul
le CI peut pousser). La PR vers `int` sert à la revue ; c'est le CI qui la livre, et la forge la marque mergée quand
le merge arrive sur la branche.

## Configuration

Dans `sfdx-project.json`, sous la clé `plugins` que Salesforce réserve aux plugins :

```json
"plugins": {
  "sfdf": {
    "orgs": [
      { "url": "https://example--int.sandbox.my.salesforce.com", "branch": "int" },
      { "url": "https://example--uat.sandbox.my.salesforce.com", "branch": "uat" },
      { "url": "https://example.my.salesforce.com", "branch": "main" }
    ]
  }
}
```

| Clé | Rôle |
| --- | --- |
| `orgs` | Obligatoire. Chaque org, identifiée par son URL My Domain, et sa branche. Une branche n'a qu'une org. |
| `remote` | Remote git des branches. Défaut : `origin`. |
| `sourceDir` | Dossier des metadata. Défaut : `force-app/main/default`. |

L'org est reconnue par l'URL de `--target-org` (l'alias change d'un poste à l'autre, l'URL non, même après un refresh).
Une org absente de la configuration est refusée.

## Déroulé

1. `git fetch` de la branche de l'org et de `--source`. Rien n'est checkout.
2. Merge virtuel : `git merge-tree --write-tree` puis `git commit-tree` produisent un commit M, sur aucune branche.
   Le merge-driver XML ([merge-driver.md](merge-driver.md)) est passé en `-c` et `.gitattributes` est lu sur la
   branche de l'org (`--attr-source`) : le CI n'a pas besoin de `merge-driver install`. Un conflit restant arrête tout.
3. Delta entre la branche (ou `--from`) et M, avec le moteur de `sf df git delta`.
4. Déploiement en **un seul job** Metadata API (SDR) : package et `destructiveChangesPost.xml` ensemble,
   `rollbackOnError`. Atomique.
5. Échec : rien n'est poussé, la branche correspond toujours à l'org. On corrige et on relance.
6. Succès : `git push <remote> M:refs/heads/<branche>`, en fast-forward seulement.

Un merge qui ne touche aucune metadata (README, CI...) est poussé sans déploiement.

## Flags

| Flag | Rôle |
| --- | --- |
| `--source`, `-s` | Branche à livrer (obligatoire). Branche du remote, ou n'importe quel commit du dépôt. |
| `--target-org`, `-o` | Org cible. Sa branche vient de la configuration. |
| `--dry-run` | Merge, delta et tests choisis, sans déployer ni pousser. |
| `--validate` | Check-only, sans pousser. Pour valider une feature dans un pipeline de PR. |
| `--from <ref>` | Point de départ du delta à la place de la branche de l'org (refresh, premier déploiement). |
| `--allow-destructive` | Obligatoire dès que le delta supprime des composants (sauf en `--validate`). |
| `--test-level`, `-l` | `NoTestRun`, `RunSpecifiedTests`, `RunLocalTests`, `RunAllTestsInOrg`. |
| `--wait`, `-w` | Minutes d'attente (défaut 60). Au-delà, le job continue dans l'org. |

Tests, sans `--test-level` : les classes `<Classe>Test` et `<Classe>_Test` des classes Apex déployées, et les classes de
test déployées elles-mêmes. Aucune trouvée : `NoTestRun`.

## Quand la branche et l'org se décalent

| Cas | Que faire |
| --- | --- |
| Déployé, mais push refusé (la branche a bougé) | Relancer la commande : la feature est redéployée (déjà dans l'org, sans gravité) puis poussée. |
| Refresh de sandbox | Relancer une fois avec `--from main` : le delta contient ce que la branche a de plus que la prod. |
| Premier déploiement d'une org qui ne correspond pas encore à sa branche | `--from` avec le commit qui décrit l'org. |
| Push à la main sur la branche | La branche est en avance sur l'org sans que la commande le sache : protéger la branche. |

## Exemple de CI (GitHub Actions)

```yaml
on:
  workflow_dispatch:
    inputs:
      source:
        description: Branche à livrer sur int
        required: true
concurrency: deploy-int   # un seul deploy à la fois par org
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: npm install --global @salesforce/cli && sf plugins install sf-df
      - run: sf org login sfdx-url --sfdx-url-file <(echo "$SFDX_URL") --alias int
        env:
          SFDX_URL: ${{ secrets.SFDX_URL_INT }}
      - run: sf df deploy --source "${{ inputs.source }}" --target-org int
```

Le token du CI doit pouvoir pousser sur la branche de l'org.

## Prérequis

- git 2.40 ou plus (`--attr-source`).
- `sf` et le plugin dans le `PATH` du CI : git appelle `sf df git merge-driver run` pour les XML conteneurs.

## Tests

- `test/deploy/deploy.test.ts` : vrais dépôts git (remote nu, clone dev, clone CI) et faux déployeur. Couvre le push
  après succès, rien poussé après échec, conflit, merge-driver lu dans `.gitattributes` de la branche, suppressions,
  dry run, validate, push refusé, `--from`, merge sans metadata, org inconnue.
- `test/deploy/config-tests.test.ts` : configuration et sélection des tests.

Pas encore prouvé en org : le déploiement via SDR (`metadataApiDeployer`). Le test e2e `metadata-lifecycle` prouve
déjà un job unique package + suppressions, mais via `sf project deploy start`.
