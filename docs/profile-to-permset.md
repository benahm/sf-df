# `sf df profile to-permset`

Command: [`src/commands/df/profile/to-permset.ts`](../src/commands/df/profile/to-permset.ts). Engine:
[`src/profile/to-permset.ts`](../src/profile/to-permset.ts).

Moves the accesses of a profile to a permission set, as Salesforce recommends (minimal profiles, accesses granted by
permission sets). Files only: nothing is sent to an org.

## What moves

An entry moves when it grants something. An entry that grants nothing stays on the profile as it is.

| Profile | Permission set | Left on the profile |
| --- | --- | --- |
| `applicationVisibilities` visible | same, without `default` | the default application stays visible, the others are set to `visible=false` |
| `classAccesses`, `customMetadataTypeAccesses`, `customPermissions`, `customSettingAccesses`, `externalDataSourceAccesses`, `flowAccesses`, `pageAccesses`, `userPermissions` enabled | same | `enabled=false` |
| `fieldPermissions` readable or editable | same | `readable=false`, `editable=false` |
| `objectPermissions` with any access | same | every flag `false` |
| `recordTypeVisibilities` visible | `recordType` and `visible` only | the default record types stay visible, the others are set to `visible=false` |
| `tabVisibilities` `DefaultOn` / `DefaultOff` | `tabSettings` `Visible` / `Available` | `Hidden` |

Everything else stays on the profile: license, layout assignments, login hours, IP ranges, login flows, category
groups, action overrides, description.

## Why the profile keeps `false` entries

A deployment never revokes an access the profile doesn't mention (verified in a sandbox, see
[`profile-strategy.ts`](../src/delta/strategies/profile-strategy.ts)). An entry removed from the file would keep its
access in the org. The moved entries therefore stay on the profile, set to `false`, and their revocation deploys.
This also matches `sf df profile retrieve --entries active`, which keeps the entries already in the file.

## Standard profiles

Salesforce doesn't let a deployment change the object and user permissions of a standard profile (`You may not modify
the permission X while editing a Standard Profile`). For a standard profile (`<custom>false</custom>`), these entries
are copied to the permission set but left as they are on the profile, with a warning.

## Deploying

The permission set is not assigned by the command: assignments are data, not metadata. To keep users' accesses:

1. Deploy the permission set.
2. Assign it to the users of the profile.
3. Deploy the profile.

`--keep-profile` writes only the permission set, for step 1. Running the command again without it revokes the
accesses on the profile: the permission set written by the first run is accepted when the profile hasn't changed, and
any other existing file of the same name is refused before anything is written.

## Naming

The API name is the profile name with letters and digits only (`System Admin + Bulk` → `System_Admin_Bulk`,
accents removed, `P_` before a leading digit, 80 characters). The label is the profile name. `--name` and `--label`
override them for a single profile.

## Org test (not run yet)

`test/e2e-org/profile-to-permset.org.e2e.test.ts` deploys a custom profile granting an object, a field, a class, a tab,
two applications and a user permission, retrieves it complete, converts it, deploys the permission set then the
profile, and compares the accesses read from the `PermissionSet` records (`ObjectPermissions`, `FieldPermissions`,
`SetupEntityAccess`, `PermissionSetTabSetting`, user permissions): the profile and the permission set together must
grant exactly what the profile granted alone. Record type visibilities are not read back.

Unit tests: `test/profile/to-permset.test.ts`, `test/commands/df/profile/to-permset.test.ts`.
