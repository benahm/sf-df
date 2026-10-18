# summary

Merge a branch into the branch of an org, deploy the result, and push the merge only if the deployment succeeds.

# description

Each org is linked to one branch in sfdx-project.json ("plugins.sfdf.orgs", the org being identified by its My Domain URL). The tip of that branch is what is deployed in the org: only this command must push to it, which a branch protection in the forge enforces.

The command fetches the org's branch and --source, merges them without checking anything out (git merge-tree, with the XML merge driver of sf df git merge-driver), computes the delta between the branch tip and the merge, and deploys it in a single atomic job: package, deletions and partial XML together. When the deployment succeeds, the merge is pushed to the branch, fast-forward only. When it fails, nothing is pushed: the branch still matches the org and the command can simply run again.

A deployment that deletes components requires --allow-destructive. Without --test-level, the tests are the classes named after the deployed Apex classes (<Class>Test, <Class>_Test), or none.

Requires git 2.40 or later.

# flags.source.summary

Branch to deliver, merged into the branch of the org.

# flags.source.description

A branch of the remote (fetched first), or any commit of the repository.

# flags.dry-run.summary

Show the merge, the delta and the tests without deploying or pushing anything.

# flags.validate.summary

Validate the deployment (check only) without pushing the merge.

# flags.validate.description

Used to check a feature before it is delivered, in a pull request pipeline for example. The org and the branch are left unchanged.

# flags.from.summary

Commit the delta starts from, instead of the tip of the org's branch.

# flags.from.description

Needed when the org no longer matches its branch: after a sandbox refresh (--from main), or for the first deployment of an org that doesn't match its branch yet.

# flags.allow-destructive.summary

Allow a deployment that deletes components from the org.

# flags.test-level.summary

Deployment test level.

# flags.test-level.description

Without this flag, RunSpecifiedTests with the test classes matching the deployed Apex classes, or NoTestRun when none matches. RunSpecifiedTests alone fails when no test class matches.

# flags.wait.summary

Number of minutes to wait for the deployment. Past this delay, the job keeps running in the org.

# spinner.start

Deploying

# spinner.error

Failed

# status.deployed

Deployed, and %s updated

# status.validated

Validated, %s unchanged

# status.dryRun

Dry run, nothing deployed

# status.nothingToDeploy

No metadata to deploy, %s up to date

# info.merge

Merge of %s into %s: %s

# info.delta

Delta: %s component(s) to deploy, %s to delete

# info.tests

Tests: %s (%s)

# info.job

Deployment job: %s

# info.deletions

Deletions:
  %s

# examples

- Deliver a feature to the org "int" (its branch comes from sfdx-project.json):

  <%= config.bin %> <%= command.id %> --source feature/JIRA-123 --target-org int

- See what would be deployed, without deploying:

  <%= config.bin %> <%= command.id %> --source feature/JIRA-123 --target-org int --dry-run

- Validate a feature in a pull request pipeline:

  <%= config.bin %> <%= command.id %> --source feature/JIRA-123 --target-org int --validate

- Redeploy after a sandbox refresh, the sandbox now holding production:

  <%= config.bin %> <%= command.id %> --source feature/JIRA-123 --target-org int --from main
