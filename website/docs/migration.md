---
title: Migrating from sfdx-mdt-plugin
sidebar_label: Migration
---

Deltaforce replaces commands of [sfdx-mdt-plugin](https://github.com/benahm/sfdx-mdt-plugin), which was built on the
retired `sfdx` CLI. Their behaviour was re-checked against real deployments rather than copied.

## `sfdx mdt:git:delta` → `sf df git delta`

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

## `sfdx mdt:profile:retrieve` → `sf df profile retrieve`

| `sfdx mdt:profile:retrieve` | `sf df profile retrieve` |
| --- | --- |
| `-p, --sourcepath` | `-d, --source-dir` (`--sourcepath` still accepted) |
| `-d, --outputdir` | `-r, --output-dir` (`--outputdir` still accepted) |
| `-u, --targetusername` | `-o, --target-org` |
| Profile missing from the org: its file was overwritten with an empty profile | The file is left untouched and the command exits with 1 |
| Profile name cut at the first dot (`Sales v1.2` read as `Sales v1`) | Full name, as `sf project retrieve` names it |
| Every file of the folder read as a profile | Only profiles are read, other files are ignored |
| Every entry the org returns | Granted accesses and the entries already in the file (`--entries all` for every entry) |
| Errors logged, exit code 0 | Status per profile, exit code 1 on any failure |

## `sfdx mdt:translations:retrieve`

No replacement: it was a plain retrieve of the source files, which `sf project retrieve start` does.
