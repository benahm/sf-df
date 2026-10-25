# `sf df org changes`

Command: [`src/commands/df/org/changes.ts`](../src/commands/df/org/changes.ts). Engine:
[`src/changes/`](../src/changes/).

Lists the latest metadata changes of an org, with their date and author, and writes them to a `package.xml` to
retrieve them. No standard command does it: `sf project retrieve preview` only shows the changes since the last
synchronisation of this machine, without date nor author, and only on orgs with source tracking.

```bash
# The 20 latest changes
sf df org changes --target-org int

# Every change I made since October 20, written to a manifest
sf df org changes --target-org int --since 2026-10-20 --by me --output-file changes.xml

# Then retrieve them, with complete profiles
sf project retrieve start --manifest changes.xml
sf df profile retrieve --manifest changes.xml
```

| Flag | Default | Description |
| --- | --- | --- |
| `-o, --target-org` | default org | Org whose changes are listed. |
| `--since` | none | Every change since this date: `2026-10-20` (local midnight) or `2026-10-20T14:30:00Z`. |
| `--limit` | 20 without `--since`, none with it | Number of changes listed, newest first. A manifest is never cut silently. |
| `--by` | every author but Automated Process | `me`, a username, a user Id or a full name. Repeatable. A full name two users share is refused. |
| `-m, --metadata-type` | every type but folders | Only these types. `Report`, `Dashboard`, `Document` and `EmailTemplate` are listed only with this flag. Repeatable. |
| `-f, --output-file` | none | Writes the components to a `package.xml`, at the project's `sourceApiVersion`. Deleted components are left out. |
| `-a, --api-version` | org's version | API version of the calls. |

`--output-file`, not `--manifest`: everywhere in `sf`, `--manifest` is a file read, not written.

## Where the dates come from

| Source | What it gives | Limits |
| --- | --- | --- |
| `listMetadata`, every type of `describeMetadata` | Date and author of the last change of every component | Some types have no date (below). Custom fields are skipped when the org has source tracking. |
| `SourceMember` (source tracking) | Changes made in Setup or deployed, **deletions included** | Only orgs with source tracking (scratch orgs, Developer and Developer Pro sandboxes). |
| `FieldPermissions`, `ObjectPermissions`, `SetupEntityAccess`, `PermissionSetTabSetting` | The newest change of the accesses of a profile or permission set | No author. A revoked access deletes its row: it leaves no trace. Only for the profiles and permission sets of the project. |

A component found by several sources is listed once, with its newest change. A deletion recorded by source tracking is
listed as `deleted`, unless `listMetadata` still lists the component (deleted, then created again).

Left out: components of installed packages (`manageableState` `installed`, `installedEditable`, `deprecated`...),
changes made by an Automated Process user (the platform's recalculations, found by `UserType`, not by name), and the
parts of components source tracking records that are no metadata type (`LightningComponentResource`): a manifest
holding them would fail.

## Rules verified on an org

Measured on a scratch org with source tracking: each change made, then the dates read back.

| Change | `listMetadata` date | `SourceMember` | Other trace |
| --- | --- | --- | --- |
| Object or field access of a profile or permission set, inserted or updated by DML (as Setup does) | unchanged | unchanged | `SystemModstamp` of the permission row, no author |
| Field access revoked (row deleted) | unchanged | unchanged | none |
| User permission or description of a permission set | moves | moves | — |
| Profile deployed | moves | — | — |
| Field label deployed | the field and its object move | both move | — |
| Custom label deployed | the `CustomLabel` moves, `CustomLabels` has no date | moves | — |

Hence the access source: without it, a profile changed in Setup would never be listed. It is limited to the project's
profiles and permission sets because creating a tab adds a row to **every** profile of the org: measured in a sandbox,
607 profiles changed in the same second. Outside the project, they would bury the real changes, and those profiles
aren't files of the project anyway.

Also measured in a sandbox:

- `listMetadata` on `CustomField` takes 27 to 31 s for 30,128 fields, the whole of the other types about 6 s. When the
  org has source tracking, custom fields are read from it only: it records the fields created in Setup and the
  deployed ones, deletions included. The Tooling `CustomField` object was rejected: its names can't be turned back into
  `package.xml` names reliably (749 of 3,000 matched; objects of installed packages, deleted fields still listed).
- `ManagedTopic` fails with the same error every time: listing makes one new attempt only, not three (14 s saved).
- `listMetadata` dates an `ExperienceBundle` from its last deployment, not from its last change in the builder:
  source tracking holds the right date.
- In `SourceMember`, a change made by Automated Process has Automated Process as both `LastModifiedById` and
  `ChangedBy`: once the platform touches a component, the earlier change made by someone isn't recorded any more.

Timings, sandbox of 120,000 components with source tracking: about 15 s, with or without `--since`.

## Types without a date

| Type | Its changes show on |
| --- | --- |
| `CustomLabels` | `CustomLabel` |
| Standard objects (`Account`...) | their fields, record types, list views |
| `CustomObjectTranslation` | `Translations` |
| Custom metadata records, `Settings` | nothing |

## Known limits

- An access revoked in Setup leaves no trace: retrieve the profile again when in doubt.
- Changes older than the last change of a component are not listed: an org only keeps the latest one.
- Folders of reports, dashboards, documents and email templates are not listed, only their contents.

Tests: `test/changes/org-changes.test.ts`, `test/changes/org-sources.test.ts`,
`test/commands/df/org/changes.test.ts`, `test/e2e-org/org-changes.org.e2e.test.ts`.
