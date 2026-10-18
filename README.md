# Deltaforce (`sf df`)

> **Beta.** Deltaforce is still in beta: review the generated delta before deploying it to production, and please
> [report issues](https://github.com/benahm/sf-df/issues).

**Documentation: [benahm.github.io/sf-df](https://benahm.github.io/sf-df/)**

A [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) plugin that builds an **incremental deployment
from a git diff**: only the metadata that changed is packaged, and deletions produce a `destructiveChanges.xml`.

Deltaforce replaces `sfdx mdt:git:delta` from [sfdx-mdt-plugin](https://github.com/benahm/sfdx-mdt-plugin), which was
built on the retired `sfdx` CLI. Its behaviour was re-checked against real deployments rather than copied: see
[what was verified on a sandbox](#deletions-verified-on-a-sandbox).

## Install

```bash
sf plugins install sf-df@beta
```

The plugin is not signed by Salesforce, so `sf` asks you to confirm the installation. In CI, add `sf-df` to
`~/.config/sf/unsignedPluginAllowList.json` to skip the question. Update with `sf plugins update`.

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

## Complete profiles: `sf df profile retrieve`

`sf project retrieve start -m Profile:Admin` only returns the accesses to the components retrieved in the same
request: on its own, a profile comes back without its field, object, class, layout or tab accesses. `sf df profile
retrieve` reads each profile with the Metadata API `readMetadata` call, which returns all of them, and writes it in the
layout of `sf project retrieve start`, so that git only shows real changes.

```bash
# Overwrite every profile of the project with the complete profile of the org
sf df profile retrieve --source-dir force-app/main/default/profiles --target-org my-sandbox

# One profile, written into another folder
sf df profile retrieve --source-dir "force-app/main/default/profiles/Admin.profile-meta.xml" --output-dir retrieved
```

| Flag | Description |
| --- | --- |
| `-d, --source-dir` | Profile file or folder. Only the profiles it contains are retrieved. **Required.** |
| `-r, --output-dir` | Where to write the profiles. Defaults to overwriting the source files. |
| `-o, --target-org` | Org to read from. |
| `--api-version` | Defaults to `sourceApiVersion` of `sfdx-project.json`: the content of a profile depends on it. |

A profile missing from the org is reported and its file is left untouched; the command then exits with 1. On a
600-profile sandbox, 50 complete profiles (97 MB) take about 2 minutes. Network errors and transient org errors are
retried 3 times.

The retrieved profile grants access to **every** component of the org, including fields and classes that are not in
the project (managed packages, changes made directly in the org). Deploying it to an org where one of them is missing
fails.

Translations need no such command: `sf project retrieve start -m "Translations:*"` and
`-m "CustomObjectTranslation:Account-fr"` already return complete files, untranslated entries included.

## Merge metadata by key: `sf df git merge-driver`

git merges Profiles, Permission Sets, Custom Labels or Translations line by line: two branches that add a field
permission or a label at the same place conflict, and a conflict often spans many unrelated elements.
`sf df git merge-driver install` adds a git merge driver that merges these files element by element, using the key of
each item (the `field` of a `fieldPermissions`, the `fullName` of a label).

```bash
# Once per clone: configures the driver and declares the files it handles in .gitattributes
sf df git merge-driver install
git add .gitattributes && git commit -m "Merge Salesforce metadata by key"
```

- Changes to different items never conflict, even when the items are next to each other.
- Both sides changed the same item differently: conflict markers surround that item only.
- One side deleted an item the other changed: conflict. Deleted and unchanged: deleted.
- Added items keep the order of the file; two sorted files give a sorted file.
- Files that can't be merged by key (not well-formed, duplicate keys) fall back to git's line merge.

Handled: Profile, PermissionSet, CustomLabels, Translations, CustomObjectTranslation, Workflow, SharingRules,
AssignmentRules, AutoResponseRules, EscalationRules, MatchingRules. `sf df git merge-driver uninstall` removes the driver.
Details: [docs/merge-driver.md](docs/merge-driver.md).

## Deliver a branch to an org: `sf df deploy`

Each org is linked to one branch, whose tip is what the org holds. `sf df deploy` merges a feature into that branch
without checkout, deploys the delta in one atomic job, and pushes the merge only if the deployment succeeded.

```bash
# Once per org: stores the org's URL and its branch in sfdx-project.json (commit it)
sf df org map --target-org int --branch int
# Show the mapping
sf df org map

sf df deploy --source feature/JIRA-123 --target-org int
```

- A failed deployment pushes nothing: the branch still matches the org.
- Only the command must push to the branch: protect it in the forge.
- `--dry-run` shows the merge, the delta and the tests; `--validate` checks without pushing.
- Deletions require `--allow-destructive`. After a sandbox refresh: `--from main`.

Details: [docs/deploy.md](docs/deploy.md).

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

## Migrating from `sfdx mdt:profile:retrieve`

| `sfdx mdt:profile:retrieve` | `sf df profile retrieve` |
| --- | --- |
| `-p, --sourcepath` | `-d, --source-dir` (`--sourcepath` still works, deprecated) |
| `-d, --outputdir` | `-r, --output-dir` (`--outputdir` still works, deprecated) |
| `-u, --targetusername` | `-o, --target-org` |
| Profile missing from the org: its file was overwritten with an empty profile | The file is left untouched and the command exits with 1 |
| Profile name cut at the first dot (`Sales v1.2` read as `Sales v1`) | Full name, as `sf project retrieve` names it |
| Every file of the folder read as a profile | Only profiles are read |
| Errors logged, exit code 0 | Status per profile, exit code 1 on any failure |

`sfdx mdt:translations:retrieve` has no replacement: it was a plain retrieve of the source files, which
`sf project retrieve start` does.

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
- [Profile retrieve](docs/profile-retrieve.md)
- [Merge driver](docs/merge-driver.md)
- [Deploy](docs/deploy.md)
- [Testing](docs/testing.md)

## Commands

<!-- commands -->
* [`sf df deploy`](#sf-df-deploy)
* [`sf df git delta`](#sf-df-git-delta)
* [`sf df git merge-driver install`](#sf-df-git-merge-driver-install)
* [`sf df git merge-driver run`](#sf-df-git-merge-driver-run)
* [`sf df git merge-driver uninstall`](#sf-df-git-merge-driver-uninstall)
* [`sf df profile retrieve`](#sf-df-profile-retrieve)

## `sf df deploy`

Merge a branch into the branch of an org, deploy the result, and push the merge only if the deployment succeeds.

```
USAGE
  $ sf df deploy -s <value> -o <value> [--json] [--flags-dir <value>] [--dry-run | --validate] [--from <value>]
    [--allow-destructive] [-l NoTestRun|RunSpecifiedTests|RunLocalTests|RunAllTestsInOrg] [-w <value>]

FLAGS
  -l, --test-level=<option>  Deployment test level.
                             <options: NoTestRun|RunSpecifiedTests|RunLocalTests|RunAllTestsInOrg>
  -o, --target-org=<value>   (required) Username or alias of the target org. Not required if the `target-org`
                             configuration variable is already set.
  -s, --source=<value>       (required) Branch to deliver, merged into the branch of the org.
  -w, --wait=<value>         [default: 60 minutes] Number of minutes to wait for the deployment. Past this delay, the
                             job keeps running in the org.
      --allow-destructive    Allow a deployment that deletes components from the org.
      --dry-run              Show the merge, the delta and the tests without deploying or pushing anything.
      --from=<value>         Commit the delta starts from, instead of the tip of the org's branch.
      --validate             Validate the deployment (check only) without pushing the merge.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Merge a branch into the branch of an org, deploy the result, and push the merge only if the deployment succeeds.

  Each org is linked to one branch in sfdx-project.json ("plugins.sfdf.orgs", the org being identified by its My Domain
  URL). The tip of that branch is what is deployed in the org: only this command must push to it, which a branch
  protection in the forge enforces.

  The command fetches the org's branch and --source, merges them without checking anything out (git merge-tree, with the
  XML merge driver of sf df git merge-driver), computes the delta between the branch tip and the merge, and deploys it
  in a single atomic job: package, deletions and partial XML together. When the deployment succeeds, the merge is pushed
  to the branch, fast-forward only. When it fails, nothing is pushed: the branch still matches the org and the command
  can simply run again.

  A deployment that deletes components requires --allow-destructive. Without --test-level, the tests are the classes
  named after the deployed Apex classes (<Class>Test, <Class>_Test), or none.

  Requires git 2.40 or later.

EXAMPLES
  Deliver a feature to the org "int" (its branch comes from sfdx-project.json):

    $ sf df deploy --source feature/JIRA-123 --target-org int

  See what would be deployed, without deploying:

    $ sf df deploy --source feature/JIRA-123 --target-org int --dry-run

  Validate a feature in a pull request pipeline:

    $ sf df deploy --source feature/JIRA-123 --target-org int --validate

  Redeploy after a sandbox refresh, the sandbox now holding production:

    $ sf df deploy --source feature/JIRA-123 --target-org int --from main

FLAG DESCRIPTIONS
  -l, --test-level=NoTestRun|RunSpecifiedTests|RunLocalTests|RunAllTestsInOrg  Deployment test level.

    Without this flag, RunSpecifiedTests with the test classes matching the deployed Apex classes, or NoTestRun when
    none matches. RunSpecifiedTests alone fails when no test class matches.

  -s, --source=<value>  Branch to deliver, merged into the branch of the org.

    A branch of the remote (fetched first), or any commit of the repository.

  --from=<value>  Commit the delta starts from, instead of the tip of the org's branch.

    Needed when the org no longer matches its branch: after a sandbox refresh (--from main), or for the first deployment
    of an org that doesn't match its branch yet.

  --validate  Validate the deployment (check only) without pushing the merge.

    Used to check a feature before it is delivered, in a pull request pipeline for example. The org and the branch are
    left unchanged.
```

_See code: [src/commands/df/deploy.ts](https://github.com/benahm/sf-df/blob/v0.0.4-beta/src/commands/df/deploy.ts)_

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

_See code: [src/commands/df/git/delta.ts](https://github.com/benahm/sf-df/blob/v0.0.4-beta/src/commands/df/git/delta.ts)_

## `sf df git merge-driver install`

Merge Salesforce metadata XML by key instead of line by line.

```
USAGE
  $ sf df git merge-driver install [--json] [--flags-dir <value>]

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Merge Salesforce metadata XML by key instead of line by line.

  Installs the "deltaforce" git merge driver in the current repository. Container metadata (Profile, PermissionSet,
  CustomLabels, Translations, CustomObjectTranslation, Workflow, SharingRules, AssignmentRules, AutoResponseRules,
  EscalationRules, MatchingRules) is then merged element by element, using the key of each item: the field of a
  fieldPermissions, the fullName of a label. Two branches that change different items of the same file no longer
  conflict, even when the items are next to each other. A conflict is only reported when both branches changed the same
  item differently, and the markers surround that item alone.

  The driver is declared in the local git config, which is not versioned: every clone runs this command once. The files
  it handles are declared in .gitattributes with "merge=deltaforce": commit it so the whole team uses the driver.
  Running the command again only adds what is missing.

  Files that can't be merged by key (not well-formed, duplicate keys) are merged line by line, as git does by default.

EXAMPLES
  Install the merge driver in the current repository:

    $ sf df git merge-driver install
```

_See code: [src/commands/df/git/merge-driver/install.ts](https://github.com/benahm/sf-df/blob/v0.0.4-beta/src/commands/df/git/merge-driver/install.ts)_

## `sf df git merge-driver run`

Merge three versions of a Salesforce metadata file by key (called by git).

```
USAGE
  $ sf df git merge-driver run --ancestor <value> --current <value> --other <value> [--json] [--flags-dir <value>]
    [--marker-size <value>] [--path <value>]

FLAGS
  --ancestor=<value>     (required) Common ancestor version of the file, given by git.
  --current=<value>      (required) Current branch version of the file, given by git.
  --marker-size=<value>  [default: 7] Length of the conflict markers, given by git.
  --other=<value>        (required) Other branch version of the file, given by git.
  --path=<value>         Path of the file in the repository, used in messages.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Merge three versions of a Salesforce metadata file by key (called by git).

  git runs this command for the files declared with "merge=deltaforce" in .gitattributes, once `sf df git merge-driver
  install` has configured the driver. It writes the merged file in place of --current and exits with code 1 when
  conflicts are left, so git reports the file as conflicted.

  Container metadata is merged element by element, using the key of each item; conflict markers surround only the items
  both sides changed differently. Files that can't be merged by key are merged line by line with `git merge-file`.

EXAMPLES
  Merge three versions of a profile, as git does:

    $ sf df git merge-driver run --ancestor base.xml --current ours.xml --other theirs.xml --path ^
      force-app/main/default/profiles/Admin.profile-meta.xml

FLAG DESCRIPTIONS
  --current=<value>  Current branch version of the file, given by git.

    Receives the merged result.
```

_See code: [src/commands/df/git/merge-driver/run.ts](https://github.com/benahm/sf-df/blob/v0.0.4-beta/src/commands/df/git/merge-driver/run.ts)_

## `sf df git merge-driver uninstall`

Remove the Salesforce metadata merge driver.

```
USAGE
  $ sf df git merge-driver uninstall [--json] [--flags-dir <value>]

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Remove the Salesforce metadata merge driver.

  Removes the "deltaforce" merge driver from the local git config, and the "merge=deltaforce" lines from .gitattributes.
  Other lines of .gitattributes are kept; the file is deleted when nothing else is left in it.

EXAMPLES
  Remove the merge driver from the current repository:

    $ sf df git merge-driver uninstall
```

_See code: [src/commands/df/git/merge-driver/uninstall.ts](https://github.com/benahm/sf-df/blob/v0.0.4-beta/src/commands/df/git/merge-driver/uninstall.ts)_

## `sf df profile retrieve`

Retrieve complete profiles, with every access they grant.

```
USAGE
  $ sf df profile retrieve -o <value> -d <value> [--json] [--flags-dir <value>] [--api-version <value>] [-r <value>]

FLAGS
  -d, --source-dir=<value>   (required) Profile file, or folder containing profiles, to retrieve.
  -o, --target-org=<value>   (required) Username or alias of the target org. Not required if the `target-org`
                             configuration variable is already set.
  -r, --output-dir=<value>   Directory where the retrieved profiles are written.
      --api-version=<value>  Override the api version used for api requests made by this command

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Retrieve complete profiles, with every access they grant.

  `sf project retrieve start` only returns the parts of a profile that relate to the components retrieved with it:
  retrieving a profile alone gives its user permissions, but not its field, object, class, page, tab, application or
  record type accesses. This command reads each profile with the Metadata API readMetadata call, which returns the whole
  profile, and writes it in the same layout as `sf project retrieve start`.

  Profiles are found in the source file or folder given by --source-dir and are overwritten in place, unless
  --output-dir is set. A profile that doesn't exist in the org is reported and its file is left untouched.

  The API version is, in order: --api-version, the sourceApiVersion of sfdx-project.json, the org's version. The content
  of a profile depends on it.

  Replaces sfdx mdt:profile:retrieve.

EXAMPLES
  Retrieve every profile of the project from the default org, overwriting the files:

    $ sf df profile retrieve --source-dir force-app/main/default/profiles

  Retrieve one profile from a given org into another folder:

    $ sf df profile retrieve --source-dir "force-app/main/default/profiles/Admin.profile-meta.xml" --target-org ^
      my-sandbox --output-dir retrieved

FLAG DESCRIPTIONS
  -d, --source-dir=<value>  Profile file, or folder containing profiles, to retrieve.

    Every profile found in this file or folder is retrieved, and only those. Other files are ignored. Replaces
    --sourcepath of sfdx mdt:profile:retrieve.

  -r, --output-dir=<value>  Directory where the retrieved profiles are written.

    When omitted, the profiles found in --source-dir are overwritten. Replaces --outputdir of sfdx mdt:profile:retrieve.
```

_See code: [src/commands/df/profile/retrieve.ts](https://github.com/benahm/sf-df/blob/v0.0.4-beta/src/commands/df/profile/retrieve.ts)_
<!-- commandsstop -->
