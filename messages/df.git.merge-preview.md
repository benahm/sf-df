# summary

Merge a branch into another without merging: compute the merge commit, or list the conflicts.

# description

The virtual merge of sf df deploy, on its own. git merge-tree merges --from into --into with the XML merge driver of sf df git merge-driver (container metadata merged by key), then git commit-tree wraps the result in a merge commit. Nothing is checked out, no branch moves, nothing is pushed: the commit only exists in the local repository.

Use it to build your own delivery pipeline: compute the delta of the merge with sf df git delta --from <into> --to <commit>, deploy it with sf project deploy start, then push the commit to the target branch (git push <remote> <commit>:refs/heads/<branch>), fast-forward only.

--from and --into are used as they are, nothing is fetched: run git fetch first and pass the remote branches (origin/<branch>). When --from is already merged into --into, the commit is the tip of --into. When the branches conflict, the files are listed and the command exits with code 1.

.gitattributes is read from --into: the repository needs no sf df git merge-driver install, but sf must be in the PATH. Requires git 2.40 or later.

# flags.from.summary

Branch or commit to merge.

# flags.from.description

Any git ref: origin/feature/JIRA-123, a local branch, a sha, refs/pull/42/head...

# flags.into.summary

Branch or commit it is merged into.

# flags.into.description

Usually the remote branch of an environment: origin/int. It becomes the first parent of the merge commit.

# flags.message.summary

Message of the merge commit. Default: "Merge <from> into <into>".

# info.merged

%s merges into %s without conflict.

# info.commit

Merge commit (on no branch):

# info.next

Next:

# info.alreadyMerged

%s is already merged into %s: nothing to merge.

# info.conflicts

%s conflicts with %s (%s file(s)):

# info.resolve

Merge %s into %s, resolve the conflicts, push, then run the command again.

# examples

- Merge feature/JIRA-123 into int without touching any branch:

  git fetch origin
  <%= config.bin %> <%= command.id %> --from origin/feature/JIRA-123 --into origin/int

- Your own delivery: merge, delta, deploy, then push only when the deployment succeeded:

  M=$(<%= config.bin %> <%= command.id %> -f origin/feature/JIRA-123 -i origin/int --json | jq -r .result.commit)
  sf df git delta --from origin/int --to $M --deploy-dir delta
  sf project deploy start --source-dir delta/force-app
  git push origin $M:refs/heads/int
