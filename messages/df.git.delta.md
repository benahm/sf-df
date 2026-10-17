# summary

Generate a Salesforce delta deployment from a git diff.

# description

Compare two git states and generate a deployable package with only the changed metadata, plus destructive changes for deleted metadata.

Container metadata (CustomLabels, Workflow, SharingRules, AssignmentRules, AutoResponseRules, MatchingRules, Profile, RecordType, Translations) is written as partial XML containing only the changed elements. Deleted elements are listed by their own type in destructiveChanges.xml.

destructiveChanges.xml never deletes more than what was deleted in git: removing one file of a bundle redeploys the bundle, and a deleted custom object is listed alone because its children are deleted with it. Metadata the Metadata API cannot delete (RecordType, Flow) is deactivated instead, with a warning asking for a manual deletion.

Run the command from the root of the git repository.

# flags.from.summary

Git ref used as the starting point.

# flags.from.description

Commit, tag, or branch used as the base snapshot for the diff.

# flags.to.summary

Git ref used as the target point.

# flags.to.description

Optional commit, tag, or branch used as the target snapshot. If omitted, the current workspace is used.

# flags.output-dir.summary

Output directory for generated package and destructive artifacts.

# flags.output-dir.description

The command creates `package/` and `destructive/` beneath this directory and writes manifests there.

# flags.source-dir.summary

Metadata source directory to inspect.

# flags.source-dir.description

Only changes under this directory are included in the delta. Defaults to `force-app/main/default`.

# spinner.start

Generating git delta

# spinner.success

Delta generated

# spinner.error

Delta generation failed

# info.summary

Processed %s delta operations.

# examples

- Generate a delta against the current workspace:

  <%= config.bin %> <%= command.id %> --from HEAD~1 --output-dir tmp/delta

- Compare two refs and write the package to a target folder:

  <%= config.bin %> <%= command.id %> --from main --to feature/my-branch --output-dir tmp/delta

- Deploy the generated delta and its destructive changes in one transaction, from the package folder (copy sfdx-project.json there first):

  <%= config.bin %> project deploy start --manifest package.xml --post-destructive-changes ../destructive/destructiveChanges.xml
