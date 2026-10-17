# Deltaforce (`sf df`)

> **Beta.** Deltaforce is still in beta: review the generated delta before deploying it to production, and please
> [report issues](https://github.com/benahm/sf-df/issues).

A [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) plugin that builds an **incremental deployment
from a git diff**: only the metadata that changed is packaged, and deletions produce a `destructiveChanges.xml`.

Deltaforce replaces `sfdx mdt:git:delta` from [sfdx-mdt-plugin](https://github.com/benahm/sfdx-mdt-plugin), which was
built on the retired `sfdx` CLI. Its behaviour was re-checked against real deployments rather than copied: see
[what was verified on a sandbox](#deletions-verified-on-a-sandbox).

## Install

The plugin is not published on npm yet. Install it from source:

```bash
git clone https://github.com/benahm/sf-df.git
cd sf-df
bun install        # or npm install
bun run compile    # or npm run compile
sf plugins link .
```

## Usage

Run the command from the root of the git repository:

```bash
# Delta between the last commit and the current workspace
sf df git delta --from HEAD --deploy-dir delta/deploy

# Delta between two refs, choosing where the destructive changes go
sf df git delta --from main --to feature/my-branch --deploy-dir delta/deploy --destructive-dir delta/destructive
```

| Flag | Description |
| --- | --- |
| `-f, --from` | Starting git ref (commit, branch, tag). **Required.** |
| `-t, --to` | Target git ref. Defaults to the current workspace. |
| `-d, --deploy-dir` | Folder of the package to deploy. **Required.** |
| `--destructive-dir` | Folder of the destructive changes. Defaults to `<deploy-dir>-destructive`, next to the deploy folder. Neither folder can be inside the other. |
| `-s, --source-dir` | Metadata folder to inspect. Defaults to `force-app/main/default`. |
| `--json` | Result as JSON (counts per status and strategy, warnings, generated paths). Its format is pinned by [`schemas/df-git-delta.json`](schemas/df-git-delta.json). |

Files excluded by the project's `.forceignore` (at each compared ref) are left out of the delta, as with
`sf project deploy`.

### Output

```text
delta/deploy/                        # --deploy-dir
  package.xml
  force-app/main/default/...         # changed files, or partial XML
delta/destructive/                   # --destructive-dir
  package.xml                        # empty, required by --post-destructive-changes
  destructiveChanges.xml
  force-app/main/default/...         # partial XML of the deleted elements (for review)
```

### Deploy

Deploy the package and the destructive changes in **one transaction**, from the package folder so that the partial XML
files are the ones deployed:

```bash
cp sfdx-project.json delta/deploy/
cd delta/deploy
sf project deploy start --manifest package.xml \
  --post-destructive-changes ../destructive/destructiveChanges.xml
```

The manifests use `sourceApiVersion` from `sfdx-project.json`.

## How metadata is handled

The delta is **minimal**: only what changed is deployed, plus the files Salesforce requires for the deployment to
succeed (for example the parent `.objectTranslation` when only a field translation changed).

| Metadata | Behaviour |
| --- | --- |
| Any metadata | The whole component is copied (source file + `-meta.xml`). |
| LWC, Aura, static resources, Aura sites (`ExperienceBundle`) | The whole bundle. Deleting one of its files redeploys the bundle instead of deleting it. LWC `__tests__` folders are excluded. |
| LWR sites (`DigitalExperienceBundle`) | Only the changed or deleted pages (`DigitalExperience`). |
| Object translations | The changed field translations plus the parent object translation. |
| `CustomLabels`, `Workflow`, `SharingRules`, `AssignmentRules`, `AutoResponseRules`, `MatchingRules` | Partial XML with only the added or changed elements. Deleted elements are listed by their own type in `destructiveChanges.xml` (`CustomLabel`, `WorkflowRule`, `SharingCriteriaRule`...). |
| `Profile`, `Translations` | Partial XML with only the added or changed elements. |
| `RecordType` | Partial XML keeping the required fields (`fullName`, `active`, `label`, `businessProcess`, `compactLayoutAssignment`). |
| `PermissionSet` | The whole file: deploying a permission set replaces it, so a partial file would revoke the other accesses. |

Large XML files (profiles, translations) are diffed without parsing the unchanged elements: a 23 MB profile takes about
1.5 s.

### Deletions verified on a sandbox

A single rejected entry makes the whole deployment fail, and `destructiveChanges.xml` must never delete more than what
was deleted in git. These rules come from real deployments and are covered by tests:

| Deleted in git | Generated delta |
| --- | --- |
| A `RecordType` (`Cannot delete record type through API`) | Deployed with `active=false`, plus a warning. |
| A `Flow` (cannot be deleted by name) | Deactivated through its `FlowDefinition`, plus a warning. |
| A `Translations` file | Never listed: it would target the whole language. |
| One field translation | Nothing destructive: the object translation still exists. |
| A custom object | The object alone (and its quick actions): fields, list views, layouts, workflows and sharing rules are deleted with it. |
| One file of a bundle | The bundle is redeployed. |

Details: [docs/git-delta-metadata-strategies.md](docs/git-delta-metadata-strategies.md).

## Migrating from `sfdx mdt:git:delta`

| `sfdx mdt:git:delta` | `sf df git delta` |
| --- | --- |
| `-f, --from` | `-f, --from` |
| `-t, --to` | `-t, --to` |
| `-p, --packagedir <dir>` | `-d, --deploy-dir <dir>` (`--packagedir` still works, deprecated) |
| `-d, --descructivedir <dir>` | `--destructive-dir <dir>` (`--descructivedir` still works, deprecated); defaults to `<deploy-dir>-destructive` |
| No manifest | `package.xml` and `destructiveChanges.xml` are generated |
| Deletion: the deleted file is copied back | Deletion: an entry in `destructiveChanges.xml` |

```bash
# before
sfdx mdt:git:delta -f origin/main -p delta -d destructive
# after
sf df git delta -f origin/main -d delta --destructive-dir destructive
```

## Development

The project follows the Salesforce plugin template ([`plugin-template-sf`](https://github.com/salesforcecli/plugin-template-sf)).

```bash
bun install
bun run build              # compile + lint
npm test                   # unit tests + Salesforce guardrails (see below)
npm run test:nuts          # runs the real command through the CLI (no org needed)
npm run test:e2e:local     # end-to-end scenarios, no org
RUN_E2E_ORG=true E2E_TARGET_ORG=<sandbox-alias> npm run test:e2e:org   # full metadata lifecycle on a sandbox
./bin/dev.js df git delta --from HEAD --deploy-dir delta/deploy
```

`npm test` also checks the command help, the command and flag snapshot (`command-snapshot.json`), the JSON result
schema (`schemas/`) and the Salesforce lint rules (`eslint-plugin-sf-plugin`). See [docs/testing.md](docs/testing.md).

Documentation:

- [Usage and output](docs/git-delta-usage.md)
- [Architecture](docs/git-delta-architecture.md)
- [Metadata strategies](docs/git-delta-metadata-strategies.md)
- [Testing](docs/testing.md)

## Commands

<!-- commands -->
* [`sf df git delta`](#sf-df-git-delta)

## `sf df git delta`

Generate a Salesforce delta deployment from a git diff.

```
USAGE
  $ sf df git delta -f <value> -d <value> [--json] [--flags-dir <value>] [-t <value>] [--destructive-dir <value>]
    [-s <value>]

FLAGS
  -d, --deploy-dir=<value>       (required) Directory where the package to deploy is generated.
  -f, --from=<value>             (required) Git ref used as the starting point.
  -s, --source-dir=<value>       [default: force-app/main/default] Metadata source directory to inspect.
  -t, --to=<value>               Git ref used as the target point.
      --destructive-dir=<value>  Directory where the destructive changes are generated.

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

  destructiveChanges.xml never deletes more than what was deleted in git: removing one file of a bundle redeploys the
  bundle, and a deleted custom object is listed alone because its children are deleted with it. Metadata the Metadata
  API cannot delete (RecordType, Flow) is deactivated instead, with a warning asking for a manual deletion.

  Run the command from the root of the git repository.

EXAMPLES
  Generate a delta against the current workspace:

    $ sf df git delta --from HEAD~1 --deploy-dir delta/deploy

  Compare two refs and choose where the destructive changes go:

    $ sf df git delta --from main --to feature/my-branch --deploy-dir delta/deploy --destructive-dir ^
      delta/destructive

  Deploy the delta and its destructive changes in one transaction, from the deploy directory (copy sfdx-project.json
  there first):

    $ sf project deploy start --manifest package.xml --post-destructive-changes ^
      ../destructive/destructiveChanges.xml

FLAG DESCRIPTIONS
  -d, --deploy-dir=<value>  Directory where the package to deploy is generated.

    Receives package.xml and the changed source files (partial XML for container metadata). Replaces --packagedir of
    sfdx mdt:git:delta.

  -f, --from=<value>  Git ref used as the starting point.

    Commit, tag, or branch used as the base snapshot for the diff.

  -s, --source-dir=<value>  Metadata source directory to inspect.

    Only changes under this directory are included in the delta. Defaults to `force-app/main/default`.

  -t, --to=<value>  Git ref used as the target point.

    Optional commit, tag, or branch used as the target snapshot. If omitted, the current workspace is used.

  --destructive-dir=<value>  Directory where the destructive changes are generated.

    Receives destructiveChanges.xml, the empty package.xml that Salesforce requires to deploy it, and the partial XML of
    the deleted elements for review. Defaults to the deploy directory followed by "-destructive", next to it. It can't
    be inside the deploy directory, or the other way round. Replaces --descructivedir of sfdx mdt:git:delta.
```

_See code: [src/commands/df/git/delta.ts](https://github.com/benahm/sf-df/blob/v0.0.1-beta/src/commands/df/git/delta.ts)_
<!-- commandsstop -->
