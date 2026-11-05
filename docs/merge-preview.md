# `sf df git merge-preview`

Command: [`src/commands/df/git/merge-preview.ts`](../src/commands/df/git/merge-preview.ts). Engine:
[`src/merge/preview.ts`](../src/merge/preview.ts), on top of `virtualMerge` in
[`src/deploy/git.ts`](../src/deploy/git.ts).

The virtual merge of [`sf df deploy`](deploy.md), on its own. It merges a branch into another **without merging**:
nothing is checked out, no branch moves, nothing is pushed. The result is a merge commit that only exists in the local
repository, or the list of conflicting files.

```bash
git fetch origin
sf df git merge-preview --from origin/feature/JIRA-123 --into origin/int
```

## Why

`sf df deploy` chains four steps: virtual merge, delta, deployment, push. Teams that keep their own pipeline get the
two steps specific to sf-df as separate commands, and write the rest themselves:

| Step | Command |
| --- | --- |
| Virtual merge | `sf df git merge-preview` |
| Delta of the merge | `sf df git delta --from <into> --to <commit>` |
| Deployment | `sf project deploy start` |
| Push, only when the deployment succeeded | `git push <remote> <commit>:refs/heads/<branch>` |

```bash
git fetch origin
M=$(sf df git merge-preview -f origin/feature/JIRA-123 -i origin/int --json | jq -r .result.commit)
sf df git delta --from origin/int --to "$M" --deploy-dir delta
sf project deploy start --source-dir delta/force-app
git push origin "$M:refs/heads/int"   # fast-forward only: refused if int moved meanwhile
```

The name says it: a preview of the merge, which merges nothing.

## How

1. `--from` and `--into` are resolved as they are. Nothing is fetched: run `git fetch` first and pass the remote
   branches (`origin/<branch>`).
2. `--from` already in `--into`: the commit is the tip of `--into`, `alreadyMerged` is `true`.
3. `git merge-tree --write-tree` merges them in the object store, with the XML merge driver
   ([merge-driver.md](merge-driver.md)) passed with `-c`, and `.gitattributes` read from `--into` (`--attr-source`).
   The repository needs no `sf df git merge-driver install`, but `sf` must be in the `PATH`.
4. `git commit-tree` wraps the tree in a merge commit: first parent `--into`, second parent `--from`. Message:
   `--message`, or `Merge <from> into <into>`. A CI runner without git identity commits as `sf-df`.
5. Conflicts: the files are listed, no commit is created, and the command exits with code 1.

## Flags

| Flag | Role |
| --- | --- |
| `--from`, `-f` | Branch or commit to merge (required). Any git ref. |
| `--into`, `-i` | Branch or commit it is merged into (required). Usually `origin/<branch of the environment>`. |
| `--message`, `-m` | Message of the merge commit. |

## `--json`

```json
{
  "from": "origin/feature/JIRA-123",
  "into": "origin/int",
  "fromCommit": "9f1c…",
  "intoCommit": "41ab…",
  "commit": "d07e…",
  "alreadyMerged": false,
  "conflicts": []
}
```

`commit` is empty when there are conflicts; `status` is then `1`.

## Prerequisites

- git 2.40 or later (`--attr-source`).
- `sf` and the plugin in the `PATH`: git calls `sf df git merge-driver run` for the container XML.

## Tests

`test/commands/df/git/merge-preview.test.ts`: merge commit and its parents, branches and working tree left alone,
message, XML merge driver read from `.gitattributes` of `--into`, conflicts and exit code, already merged, unknown ref.
