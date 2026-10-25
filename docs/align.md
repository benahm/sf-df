# `sf df org align`

Command: [`src/commands/df/org/align.ts`](../src/commands/df/org/align.ts). Engine: [`src/align/`](../src/align/).

A profile, a permission set or a translation is refused **as a whole** when one of its entries refers to a component
the target org lacks: a field of a managed package, a class created in another sandbox, a label not deployed yet, a
feature that is not enabled. `sf df org align` lists what the target org holds and rewrites the files without those
entries. It replaces the `adapt` commands of sfdx-mdt-plugin.

```bash
# Show what would be removed, without changing any file
sf df org align --target-org uat --dry-run

# Align the files of a delta before deploying it
sf df org align --target-org uat --source-dir delta
```

| Flag | Description |
| --- | --- |
| `-o, --target-org` | Org the files will be deployed to. |
| `-d, --source-dir` | Files or folders to align. Defaults to the project's `packageDirectories`. Repeatable. |
| `--dry-run` | Lists the entries without changing the files. |
| `-a, --api-version` | API version of the calls. |

## What is removed

The rule: removing an entry only removes an access or a translation, never a behaviour. A component of the project is
deployed with the files: a reference to it is **kept**, even when the org doesn't have it yet.

| Type | Entries checked |
| --- | --- |
| `Profile`, `PermissionSet`, `MutingPermissionSet` | field, object, class, page, flow, application, tab, record type, layout, custom permission, external data source, custom setting and custom metadata type accesses, service presence statuses, `userPermissions` |
| `PermissionSetGroup` | `permissionSets`, `mutingPermissionSets` |
| `Translations` | applications, labels, tabs, flows, quick actions, report types |
| `CustomObjectTranslation` | field sets, layouts, quick actions, record types, validation rules, web links; a `.fieldTranslation` file whose field is missing is **deleted** |

Nothing is removed on a guess:

- A type the org can't list keeps all its references, with a warning. Exception: `INVALID_TYPE` means the org lacks the
  feature (Omni-Channel for `ServicePresenceStatus`), hence all of its components: the references are removed.
- The translation of an object missing from the org and from the project is left as is, with a warning: removing it
  would remove the whole translation.
- A file that can't be read as a metadata XML is left as is, with a warning.
- The rest of the file is kept byte for byte (indentation, CRLF, comments): only the removed entries go.

## Where "what the org holds" comes from

| References | Read with |
| --- | --- |
| Components (classes, custom fields, layouts, labels, standard applications included...) | `listMetadata`, one call per type, 5 in parallel. A managed component is known as `ns__Name` and `ns.Name`. |
| `userPermissions` | The `Permissions*` fields of `describe('PermissionSet')`. |
| Standard objects and fields | `FieldDefinition` (Tooling API), 50 objects per query, only for the standard objects the accesses name. Not `describe`, which depends on the field-level security of the user. |
| Standard tabs | `TabDefinition` (Tooling API): `listMetadata CustomTab` doesn't list the standard tabs. |

Names are compared decoded and case-insensitively. Custom fields of `Task` and `Event` are `Activity` fields, a person
account field (`Account.X__pc`) is a `Contact` field.

## Default application of a profile

A profile without a default application is refused (`You can't remove the only default app from the profile`), also
when the remaining entries have no `<default>` element. When align removes the default application of the file, it
reads the profile in the target org and makes its default application there the default one. When the target org lacks
the profile, a warning says so.

## Verified on an org

A complete `Admin` profile (`sf df profile retrieve --entries all`), three permission sets, `Translations:fr` and two object
translations, retrieved from a customer sandbox, then deployed to a new Developer scratch org:

| | Before align | After align |
| --- | --- | --- |
| Validation | 6 components refused out of 7 | 2 refused, for reasons outside the scope of align (below) |
| Real deployment, these two reasons neutralised | – | 7 components out of 7 deployed |

align removed 23,080 entries from 779 files in about 14 s. Each aligned file is an exact subsequence of the original:
no line added, order kept. The rules found during this test (standard objects and fields, standard applications and
tabs, service presence statuses, web links and quick actions, default application) each have a fast test in
`test/align/align.test.ts` ("verified on a scratch org").

## Known limits

These errors don't come from a missing reference: align doesn't handle them.

- **Standard profile**: `You may not modify the permission X while editing a Standard Profile`. The `userPermissions` of
  a standard profile (`Admin`...) can't be changed by a deployment when they differ from the target org.
- **Declined forms of a renamed object**: `caseValues` returned by the source org without `<article>` are refused
  (`duplicate value found`).
- The duplicate `layoutAssignment` on a person account record type is left out by `sf df profile retrieve`, see
  [profile-retrieve.md](profile-retrieve.md).

Tests: `test/align/align.test.ts`, `test/commands/df/org/align.test.ts`.
