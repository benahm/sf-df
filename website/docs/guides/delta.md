---
title: Build a delta
---

[`sf df git delta`](../commands/df-git-delta.md) builds an incremental deployment from a git diff: only the metadata that
changed is packaged, and deletions produce a `destructiveChanges.xml`. `sf df deploy` uses the same engine; use this
command when you deploy with your own scripts.

```bash
# Delta between the last commit and the current workspace
sf df git delta --from HEAD --deploy-dir delta/deploy

# Delta between two refs, choosing where the destructive changes go
sf df git delta --from main --to feature/my-branch --deploy-dir delta/deploy --destructive-dir delta/destructive
```

Files excluded by the project's `.forceignore` (at each compared ref) are left out, as with `sf project deploy`.

## Output

```text
delta/deploy/                        # --deploy-dir
  package.xml
  force-app/main/default/...         # changed files, or partial XML
delta/destructive/                   # --destructive-dir
  package.xml                        # empty, required by --post-destructive-changes
  destructiveChanges.xml
  force-app/main/default/...         # partial XML of the deleted elements (for review)
```

## Deploy it

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

## Deletions verified on a sandbox

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
