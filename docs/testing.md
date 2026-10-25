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
| `cross-cutting.test.ts` | untracked and ignored files, commit ranges, parity of the test helper with git |

Tests share `test/delta/helpers/delta-repo.ts` (a temporary repository and a readable view of the delta) and
`test/delta/helpers/metadata-xml.ts` (builders for metadata source files). A test whose expected result depends on how
Salesforce reacts says in a comment whether it was verified in a sandbox; a known gap says so in its name or comment.

## Tests with and without git

`useDeltaRepo()` gives a `FolderDeltaRepo` by default: each commit is a plain folder, the helper computes the changed
files itself and hands both folders to `generateDelta` through its `source` option. No git process runs, a test takes
a fraction of a second. `useDeltaRepo({ git: true })` gives a real git repository (`GitDeltaRepo`), same API.

A test goes on git only when it is about git: untracked or ignored files, staging, `git` commands, refs that are not
`HEAD`, `HEAD~n` or an id returned by `commit()`, and rename detection. `FolderDeltaRepo` only knows the renames made
with `rename()`; git also pairs a deleted file with a similar new one. `cross-cutting.test.ts` checks that both
flavours give the same delta on a scenario mixing additions, changes, deletions and renames.

## Keeping the unit tests fast

Most of the time of a git-based delta test goes to git processes, which cost 100-250 ms each on Windows: that is why
most delta tests run without git (see above). Two things keep the remaining git tests usable:

- mocha runs the test files in parallel (`"parallel": true` and `"jobs": 4` in `.mocharc.json`). Each
  file runs whole in one worker, files share nothing: a test that changes the process state (`process.chdir`,
  `process.env`) restores it in its `after` hook, and a test never depends on another file. A single file still runs
  with `npx mocha test/delta/types/apex.test.ts`.
- `GitDeltaRepo.create()` copies an empty repository (initialised and configured once per worker, automatic
  maintenance off) instead of running `git init` and `git config` for every test, and `commit()` reads the new sha
  from `.git` instead of running `git rev-parse`. A new helper avoids extra git processes the same way.
- ts-node only transpiles (`"ts-node": { "transpileOnly": true }` in `tsconfig.json`): type-checking every file in
  every worker took 15-30 s per worker. Types are still checked by `npm run test:compile`, the first step of
  `npm test`, and by `npm run compile`.

Timing assertions (`test/merge/xml-merge.test.ts`, `test/delta/xml.test.ts`) guard against an algorithm gone quadratic,
not against a slow machine: their budget stays well above the normal duration measured while the other files run in
parallel.

Measured on Windows, 8 cores, `nyc mocha "test/**/*.test.ts"` (300 tests): 910 s run serially with a `git init` per
test, 388 s in parallel. More workers is not faster: git processes saturate the CPU (503 s with 7 workers, 436 s with 3),
hence `"jobs": 4`. Then, on a machine where any process takes ~200 ms to start, the whole `npm test` (309 tests) went
from 969 s to 503 s with the delta tests off git and ts-node transpiling only; `mocha` alone, without nyc, takes 221 s.
The remaining time is mostly the git-based tests (`test/deploy/deploy.test.ts` first) and nyc.

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

### Profile to permission set on an org

`test/e2e-org/profile-to-permset.org.e2e.test.ts` deploys a custom profile, an object, a field, a tab and a class (all
`SfDfQa*`), converts the profile with `sf df profile to-permset`, deploys the permission set then the profile, and
checks that both together grant exactly what the profile granted alone. Everything is deleted at the end. See
[profile-to-permset.md](profile-to-permset.md).

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
