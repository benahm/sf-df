# Deltaforce (`sf df`)

Plugin [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) qui génère un **déploiement incrémental** à partir d'un diff git : seules les metadata modifiées sont packagées, et les suppressions produisent un `destructiveChanges.xml`.

Deltaforce remplace la commande `sfdx mdt:git:delta` de [sfdx-mdt-plugin](https://github.com/benahm/sfdx-mdt-plugin), construite sur l'ancienne CLI `sfdx` qui n'est plus supportée.

## Installation

```bash
sf plugins install sf-df
```

## Utilisation

À lancer depuis la racine du dépôt git :

```bash
# Delta entre le dernier commit et le workspace courant
sf df git delta --from HEAD --output-dir tmp/delta

# Delta entre deux refs
sf df git delta --from main --to feature/my-branch --output-dir tmp/delta
```

| Flag | Description |
|---|---|
| `-f, --from` | Ref git de départ (commit, branche, tag). **Obligatoire.** |
| `-t, --to` | Ref git d'arrivée. Par défaut : le workspace courant. |
| `-d, --output-dir` | Dossier de sortie. **Obligatoire.** |
| `-s, --source-dir` | Dossier des metadata à analyser. Par défaut : `force-app/main/default`. |
| `--json` | Résultat au format JSON (compteurs par statut et par stratégie, warnings, chemins générés). |

### Sortie

```text
tmp/delta/
  package/
    package.xml
    force-app/main/default/...       # fichiers modifiés, ou XML partiels
  destructive/
    package.xml                      # vide, requis par --post-destructive-changes
    destructiveChanges.xml
    force-app/main/default/...       # XML partiels des éléments supprimés (pour revue)
```

### Déploiement

```bash
sf project deploy start --source-dir tmp/delta/package/force-app
sf project deploy start --manifest tmp/delta/destructive/package.xml \
  --post-destructive-changes tmp/delta/destructive/destructiveChanges.xml
```

## Traitement des metadata

| Metadata | Comportement |
|---|---|
| Toute metadata | Le composant complet est copié (fichier source + `-meta.xml`, ou bundle complet). |
| LWC | Bundle complet, sans les dossiers `__tests__`. |
| Aura, Experience bundles, Static resources | Bundle ou dossier complet avec son `-meta.xml`. |
| Object translations | Dossier de traduction de l'objet, fichier parent inclus. |
| `CustomLabels`, `Workflow`, `SharingRules`, `AssignmentRules`, `AutoResponseRules`, `MatchingRules` | XML partiel avec uniquement les éléments ajoutés ou modifiés. Les éléments supprimés sont listés par type enfant dans `destructiveChanges.xml` (`CustomLabel`, `WorkflowRule`, `SharingCriteriaRule`…). |
| `Profile`, `Translations` | XML partiel des éléments ajoutés ou modifiés. Pas de suppression partielle (warning). |
| `RecordType` | XML partiel en conservant les champs requis (`fullName`, `active`, `label`, `businessProcess`, `compactLayoutAssignment`). |

La version d'API des manifests est lue dans `sourceApiVersion` de `sfdx-project.json`.

## Migration depuis `sfdx mdt:git:delta`

| `sfdx mdt:git:delta` | `sf df git delta` |
|---|---|
| `-f, --from` | `-f, --from` |
| `-t, --to` | `-t, --to` |
| `-p, --packagedir <dir>` | `-d, --output-dir <out>` → le package est dans `<out>/package` |
| `-d, --descructivedir <dir>` | toujours généré dans `<out>/destructive` |
| Pas de manifest | `package.xml` et `destructiveChanges.xml` générés |
| Suppression : fichier supprimé recopié | Suppression : entrée dans `destructiveChanges.xml` |

Exemple de pipeline :

```bash
# avant
sfdx mdt:git:delta -f origin/main -p delta -d destructive
# après
sf df git delta -f origin/main -d tmp/delta
```

## Développement

```bash
bun install
bun run build          # compile + lint
npm test               # tests unitaires (mocha)
npm run test:e2e:local # scénarios de bout en bout, sans org
npm run test:e2e:org   # déploiement réel sur une scratch org
npm run test-ui        # interface web de pilotage des tests
./bin/dev.js df git delta --from HEAD --output-dir tmp/delta
```

Documentation détaillée :

- [Usage et sorties](docs/git-delta-usage.md)
- [Architecture](docs/git-delta-architecture.md)
- [Stratégies metadata](docs/git-delta-metadata-strategies.md)
- [Tests](docs/testing.md)

## Commandes

<!-- commands -->
* [`sf df git delta`](#sf-df-git-delta)

## `sf df git delta`

Generate a Salesforce delta deployment from a git diff.

```
USAGE
  $ sf df git delta -f <value> -d <value> [--json] [--flags-dir <value>] [-t <value>] [-s <value>]

FLAGS
  -d, --output-dir=<value>  (required) Output directory for generated package and destructive artifacts.
  -f, --from=<value>        (required) Git ref used as the starting point.
  -s, --source-dir=<value>  [default: force-app/main/default] Metadata source directory to inspect.
  -t, --to=<value>          Git ref used as the target point.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Generate a Salesforce delta deployment from a git diff.

  Compare two git states and generate a deployable package with only the changed metadata, plus destructive changes for
  deleted metadata.

  Container metadata (CustomLabels, Workflow, SharingRules, AssignmentRules, AutoResponseRules, MatchingRules, Profile,
  RecordType, Translations) is written as partial XML containing only the changed elements. Deleted elements are listed
  by their own type in destructiveChanges.xml.

  Run the command from the root of the git repository.

EXAMPLES
  Generate a delta against the current workspace:

    $ sf df git delta --from HEAD~1 --output-dir tmp/delta

  Compare two refs and write the package to a target folder:

    $ sf df git delta --from main --to feature/my-branch --output-dir tmp/delta

  Deploy the generated delta, then its destructive changes:

    $ sf project deploy start --source-dir tmp/delta/package/force-app
    $ sf project deploy start --manifest tmp/delta/destructive/package.xml --post-destructive-changes \
      tmp/delta/destructive/destructiveChanges.xml

FLAG DESCRIPTIONS
  -d, --output-dir=<value>  Output directory for generated package and destructive artifacts.

    The command creates `package/` and `destructive/` beneath this directory and writes manifests there.

  -f, --from=<value>  Git ref used as the starting point.

    Commit, tag, or branch used as the base snapshot for the diff.

  -s, --source-dir=<value>  Metadata source directory to inspect.

    Only changes under this directory are included in the delta. Defaults to `force-app/main/default`.

  -t, --to=<value>  Git ref used as the target point.

    Optional commit, tag, or branch used as the target snapshot. If omitted, the current workspace is used.
```
<!-- commandsstop -->
