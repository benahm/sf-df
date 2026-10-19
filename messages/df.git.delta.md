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

Optional commit, tag, or branch used as the target snapshot. If omitted, the current workspace is used as it is on disk, including files not added to git yet (files excluded by .gitignore are left out).

# flags.deploy-dir.summary

Directory where the package to deploy is generated.

# flags.deploy-dir.description

Receives package.xml and the changed source files (partial XML for container metadata). Replaces --packagedir of sfdx mdt:git:delta.

# flags.destructive-dir.summary

Directory where the destructive changes are generated.

# flags.destructive-dir.description

Receives destructiveChanges.xml, the empty package.xml that Salesforce requires to deploy it, and the partial XML of the deleted elements for review. Defaults to the deploy directory followed by "-destructive", next to it. It can't be inside the deploy directory, or the other way round. Replaces --descructivedir of sfdx mdt:git:delta.

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

  <%= config.bin %> <%= command.id %> --from HEAD~1 --deploy-dir delta/deploy

- Compare two refs and choose where the destructive changes go:

  <%= config.bin %> <%= command.id %> --from main --to feature/my-branch --deploy-dir delta/deploy --destructive-dir delta/destructive

- Deploy the delta and its destructive changes in one transaction, from the deploy directory (copy sfdx-project.json there first):

  <%= config.bin %> project deploy start --manifest package.xml --post-destructive-changes ../destructive/destructiveChanges.xml
