# summary

Generate a modular Salesforce delta from a git diff.

# description

Compare two git states and generate a delta package, a destructive manifest, and metadata-specific partial XML when needed.

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

Defaults to `force-app/main/default` for the V1 implementation.

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
