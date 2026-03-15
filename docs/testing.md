# Testing Guide

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

Useful environment variables:

1. `RUN_E2E_ORG=true`: enable org test execution.
2. `E2E_TARGET_ORG`: reuse an existing org instead of creating a scratch org.
3. `DEV_HUB_ALIAS`: Dev Hub alias when creating scratch orgs.
4. `SCRATCH_DURATION_DAYS`: scratch org duration in days.
5. `E2E_KEEP_ORG=true`: keep a created scratch org after test run.

## Delta output format

`sf df git delta` writes SFDX source-format output:

```text
<output-dir>/
  package/
    force-app/main/default/...
    package.xml
  destructive/
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
  --source-dir <delta-output>/package/force-app/main/default \
  --ignore-conflicts \
  --ignore-warnings \
  --wait 30
```
