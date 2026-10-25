# `sf df profile retrieve`

Command: [`src/commands/df/profile/retrieve.ts`](../src/commands/df/profile/retrieve.ts). Engine:
[`src/retrieve/`](../src/retrieve/).

Retrieves complete profiles, ready to deploy. Every other type is left to `sf project retrieve start`: sf-df doesn't
wrap a command that already works. Replaces `sfdx mdt:profile:retrieve`.

## Why profiles need their own command

`sf project retrieve start -m Profile:X` only returns the accesses to the components retrieved in the same request.
Measured on a 610-profile sandbox (API 64.0), `Admin` profile:

| | Native retrieve alone | `readMetadata` |
| --- | --- | --- |
| `classAccesses` | 31 | 1942 |
| `fieldPermissions` | 448 | 7019 |
| `layoutAssignments` | 2 | 1154 |
| `objectPermissions` | 3 | 804 |

Getting the complete profile natively means retrieving everything with it. The command reads the profile with
`readMetadata`, which returns all of it.

A native retrieve that includes profiles overwrites them with partial ones: retrieve the other types without the
profiles, or run this command after it.

Translations don't have this problem: `Translations:fr` retrieved alone (28 s) is byte for byte the file retrieved
with every translatable component (202 s), `<!-- master label -->` comments included. Same for
`CustomObjectTranslation:Account-fr` (19 s alone, 68 s with `CustomObject:Account`). Hence no `translations retrieve`.

## Choosing the profiles

The flags of `sf project retrieve start`: same names, characters and exclusions (`-o`, `-a`, `-d`, `-m`, `-x`, `-r`).

- `-d`, `-m` and `-x` are mutually exclusive. Without any of them: every profile of the `packageDirectories`.
- `-m Profile` is every profile of the org; `-m "Profile:Sales*"` resolves the wildcard against the org
  (`listMetadata`). An exact name doesn't query the org. `-x` only reads the `Profile` members of the manifest.
- A profile already in the project is overwritten in place, even when its name is given decoded (`+` for `%2B`). A new
  one goes to `<default package>/main/default/profiles`.
- `-r` writes to `<output-dir>/profiles`, as the native command does. Unlike the native command, `-r` is allowed with
  `-d`, so that `--sourcepath` + `--outputdir` of `mdt:profile:retrieve` keep working (both are accepted as aliases).
- `-a` defaults to the `sourceApiVersion` of `sfdx-project.json`: the content of a profile depends on it.
- `listMetadata` goes through the same raw SOAP call as `readMetadata`: `connection.metadata.list` of jsforce has its
  own transport, without the session refresh and the retries.

## Profile content: `--entries` and `--scope`

Two independent options, applied to the complete profile returned by `readMetadata`
([`src/retrieve/profile-filter.ts`](../src/retrieve/profile-filter.ts)):

| Option | Sorts the accesses by | Values |
| --- | --- | --- |
| `--entries` | their **value** | `active` (default): granted accesses, plus the entries already in the project's file, with the org's value. `all`: everything. |
| `--scope` | the **component they refer to** | `org` (default): every component of the org. `project`: the components of the `packageDirectories` and standard ones. |

- A deployment never revokes an access the profile doesn't mention (verified in a sandbox, see
  `profile-strategy.ts`). `active` therefore keeps the entries already in the local file: an access revoked in the
  org is written as `false` instead of disappearing, and its revocation deploys.
- `active` doesn't touch tabs (`Hidden` is a choice), layout assignments or profile settings.
- `project` looks at the whole project, not only what is retrieved. Standard = object or field without `__`, tab
  `standard-*`, application `standard__*`. A layout, record type, class, page, flow, custom permission or external
  data source must be in the project.
- The local file is read before being replaced, even with `--output-dir`. The filter works on the re-indented text,
  element by element, without a full parse (30,000 entries in about 1 s, guarded by
  `test/retrieve/profile-filter.test.ts`).

Measured on a sandbox, `Admin` profile: 63,665 lines with `all`, 55,980 with `active`, 18,767 with `active` +
`project` (project reduced to one object).

## A profile that deploys

[`src/retrieve/profile-deployable.ts`](../src/retrieve/profile-deployable.ts) leaves out, with a warning, the entries
the org returns but refuses to deploy. Found by check-only deployments (`--dry-run`) of the `Admin` profile retrieved
from the same sandbox:

- **Standard tabs missing from `TabDefinition`**: 103 of the 480 standard tab settings
  (`You can't edit tab settings for AccountAccountRelation, as it's not a valid tab`). The command lists the standard
  tabs of the org (`SELECT Name FROM TabDefinition WHERE Name LIKE 'standard-%'`, Tooling API) and leaves out the
  settings of the others. When the query fails, every tab setting is kept.
- **Two layouts for one record type**: the org held two `ProfileLayout` rows for six person account record types,
  returned by `readMetadata` and by `sf project retrieve start` alike (`Duplicate layoutAssignment`). Which one
  applies can't be told: both are left out, and the deployment leaves the target org's assignment as it is. Assign one
  layout in the org, then retrieve again. Two assignments of one record type to `Case-X` and `CaseClose-Y` are not
  duplicates.

The 104th refused tab of that sandbox, `standard-OmniSupervisor`, is listed by `TabDefinition` (Classic only, like
`standard-Document` which deploys): it is still in the file. With it removed, the `Admin` profile validates.

## Limit: `--scope org` holds every access of the org

`readMetadata` returns the accesses to **every** component of the org, not only those of the project: fields of
managed packages, fields created directly in the sandbox... Deploying this profile to an org where one of them is
missing fails (`no CustomField named X found`). `mdt:profile:retrieve` behaved the same. Use `--scope project`, or
`sf df org align` before deploying.

## How profiles are read

1. Profiles are found by SDR (`ComponentSet.fromSource`). The full name is the encoded file name
   (`System Admin %2B Bulk Delete Permission`), which is also the name the API expects. Other files are ignored.
2. One SOAP `readMetadata` call **per profile**, 5 in parallel. The org serves the profiles of one call one after
   the other: 6 profiles in one call = 67 s, in 6 parallel calls = 27 s.
3. The response is kept as **raw text** (`responseType: 'text/plain'`): jsforce would build a large object tree (16 s
   instead of 7.5 s for a 1.6 MB profile) and casts some booleans but not others. The XML of the response is already
   in the order and with the escaping of a retrieve: it is only re-indented, not parsed.
4. Each profile is written as soon as it arrives, to a temporary file renamed afterwards: an interrupted command never
   leaves a truncated profile. 50 profiles (97 MB) fit in a heap limited to 128 MB.
5. A transient error (connection reset, HTTP 5xx, `UNKNOWN_EXCEPTION`, `SERVER_UNAVAILABLE`,
   `REQUEST_LIMIT_EXCEEDED`) is retried 3 times (2 s, 4 s, 8 s). An error of the request is not.
6. Parallel calls that see the session expire share a single refresh.

## Rules verified in a sandbox

Tests: `test/delta/sandbox-findings.test.ts` ("profile retrieve") and `test/e2e-org/profile-retrieve.org.e2e.test.ts`.

- Every element of a natively retrieved profile is found, unchanged and in the same order, in the profile written by
  the command (`Admin`, `System Admin %2B Bulk Delete Permission`, and profiles whose description holds `"` and
  `\r\n`).
- An unknown profile comes back as `<records xsi:nil="true"/>`. The local file is left untouched and the command exits
  with 1: `mdt:profile:retrieve` wrote an empty profile over it, which removed every access on the next deployment.
- The session token travels in the SOAP envelope, which jsforce doesn't refresh: on `INVALID_SESSION_ID`, the command
  refreshes the token and replays the call once.
- The settings of standard tabs missing from `TabDefinition` and the duplicate layout assignments are refused at
  deployment (see above).

Intended differences with `mdt:profile:retrieve`: `test/delta/mdt-parity.test.ts` ("mdt:profile:retrieve parity").
