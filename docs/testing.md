# Testing Guide

## `npm test`: the guardrails

`npm test` runs the same checks as the Salesforce plugin template (`salesforcecli/plugin-template-sf`):

| Script | Checks |
| --- | --- |
| `test:compile` | the tests type-check |
| `test:only` | unit tests (`test/**/*.test.ts`, mocha) |
| `test:command-reference` | the command help generates without warnings (`@salesforce/plugin-command-reference`) |
| `test:deprecation-policy` | commands and flags match `command-snapshot.json`: removing or renaming one breaks users |
| `test:json-schema` | the `--json` result matches `schemas/*.json`: CI pipelines parse it |
| `lint` | oxlint, then ESLint with `eslint-config-salesforce-typescript` and `eslint-plugin-sf-plugin` |

When a command or its JSON result changes on purpose, regenerate the reference files and commit them:

```bash
node --loader ts-node/esm --no-warnings=ExperimentalWarning ./bin/dev.js snapshot:generate
node --loader ts-node/esm --no-warnings=ExperimentalWarning ./bin/dev.js schema:generate
```

## Delta tests by metadata type

`test/delta/types/` holds one file per metadata type (or family) and covers, for each, the same matrix: addition,
change of a simple field, change of one item of a collection, pure reformatting, deletion, rename, deletion of the
parent, changes spanning several commits.

| File | Types |
| --- | --- |
| `record-type.test.ts` | RecordType: singletons, picklist values, deactivation, rename |
| `profile.test.ts` | Profile: one test per keyed collection, removed items, rename |
| `permission-set.test.ts` | PermissionSet, PermissionSetGroup, MutingPermissionSet |
| `custom-object.test.ts` | CustomObject, CustomField, ListView, ValidationRule |
| `translations.test.ts` | Translations, CustomObjectTranslation |
| `flow.test.ts` | Flow |
| `container-rules.test.ts` | CustomLabels, Workflow, SharingRules |
| `apex.test.ts` | ApexClass, ApexTrigger |
| `bundles.test.ts` | LightningComponentBundle, AuraDefinitionBundle |
| `pages-and-actions.test.ts` | Layout, FlexiPage, QuickAction, CompactLayout, WebLink, FieldSet, BusinessProcess |
| `custom-metadata-and-value-sets.test.ts` | CustomMetadata records, GlobalValueSet, StandardValueSet |
| `cross-cutting.test.ts` | untracked and ignored files, commit ranges |

Tests share `test/delta/helpers/delta-repo.ts` (a temporary git repository and a readable view of the delta) and
`test/delta/helpers/metadata-xml.ts` (builders for metadata source files). A test whose expected result depends on how
Salesforce reacts says in a comment whether it was verified in a sandbox; a known gap says so in its name or comment.

## NUTs

`npm run test:nuts` runs `test/**/*.nut.ts` with `@salesforce/cli-plugins-testkit`: the real command is executed through
the CLI in a temporary git repository. No org is needed.

## Test suites

The project has 2 end-to-end test modes:

1. `e2e-local`: validates generated delta files locally.
2. `e2e-org`: validates delta generation + real deployment to a Salesforce org.

Commands:

```bash
npm run test:e2e:local
npm run test:e2e:org
```

## Fixture structure

Scenarios live under:

```text
test/fixtures/scenarios/<scenario-name>/
  baseline/
    force-app/main/default/...
    sfdx-project.json
  changed/
    force-app/main/default/...
  expected/
    force-app/main/default/...
```

Meaning:

1. `baseline`: initial source to commit and deploy first.
2. `changed`: source copied into the repo after baseline to generate the delta.
3. `expected`: expected final source state after applying the delta.

## e2e-local flow

For each scenario:

1. Create a temp git repo from `baseline/`.
2. Commit baseline.
3. Copy `changed/` over baseline.
4. Run delta generation.
5. Assert generated files and manifests.

## e2e-org flow

For each scenario:

1. Create temp git repo from `baseline/`.
2. Deploy baseline to target org.
3. Copy `changed/`.
4. Run `sf df git delta`.
5. Deploy generated package delta to target org.
6. Validate generated output against `expected/`.

Run against an existing org (recommended when scratch quota is limited):

```bash
RUN_E2E_ORG=true E2E_TARGET_ORG=<org-alias-or-username> npm run test:e2e:org
```

Run with scratch org creation:

```bash
RUN_E2E_ORG=true DEV_HUB_ALIAS=DevOrg SCRATCH_DURATION_DAYS=1 npm run test:e2e:org
```

### Metadata lifecycle on a sandbox

`test/e2e-org/metadata-lifecycle.org.e2e.test.ts` replays, on an existing org, the scenario used to harden the command:
the most common metadata types (Apex, Visualforce, LWC, Aura, custom object and its children, layout, FlexiPage, flow,
permission set, custom permission, labels, custom metadata, tab, app, quick action, group, sharing rules, workflow,
email templates, reports, static resources, object and label translations) are added, modified / partially deleted /
renamed, then deleted. Each delta is deployed in one transaction and the org is retrieved to check it matches the repo.

```bash
RUN_E2E_ORG=true E2E_TARGET_ORG=<sandbox-alias> npm run test:e2e:org
```

- Only `SfDfQa*` components are created and the test deletes them; objects get a per-run suffix because deleted
  objects stay 15 days in the recycle bin.
- The translation workbench must have `E2E_ORG_LANGUAGE` (default `fr`) enabled.
- Takes about 15 minutes.

The behaviours it uncovered are pinned by fast unit tests in `test/delta/sandbox-findings.test.ts`.

### Profile retrieve on a sandbox

`test/e2e-org/profile-retrieve.org.e2e.test.ts` is read only: it retrieves `E2E_ORG_PROFILE` (default `Admin`) with
`sf project retrieve start` together with `CustomObject:Account` and the Apex classes, then checks that every element of
that file is found, unchanged and in the same order, in the complete profile written by `sf df profile retrieve`.
Takes about 2 minutes. See [profile-retrieve.md](profile-retrieve.md).

Useful environment variables:

1. `RUN_E2E_ORG=true`: enable org test execution.
2. `E2E_TARGET_ORG`: reuse an existing org instead of creating a scratch org.
3. `DEV_HUB_ALIAS`: Dev Hub alias when creating scratch orgs.
4. `SCRATCH_DURATION_DAYS`: scratch org duration in days.
5. `E2E_KEEP_ORG=true`: keep a created scratch org after test run.

## Delta output format

`sf df git delta` writes SFDX source-format output:

```text
<deploy-dir>/
  force-app/main/default/...
  package.xml
<destructive-dir>/              # default: <deploy-dir>-destructive
  force-app/main/default/...
  destructiveChanges.xml
```

## Deploying package vs destructive

`sf project deploy start` has a CLI constraint:

1. `--source-dir` cannot be used with `--manifest`.
2. `--post-destructive-changes` requires `--manifest`.

So destructive deployment must be done in a separate command from source-dir deployment.

Package-only deploy example:

```bash
sf project deploy start \
  --target-org <org> \
  --source-dir <deploy-dir>/force-app/main/default \
  --ignore-conflicts \
  --ignore-warnings \
  --wait 30
```
