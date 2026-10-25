# summary

Remove from the local files the references to components the target org lacks, so that they deploy.

# description

A profile, a permission set or a translation fails to deploy as a whole when one of its entries refers to a component the target org doesn't have: a field of a managed package, a class created in another sandbox, a label not deployed yet. This command lists the components of the target org and rewrites the files without those entries. Everything else in the files is kept as is.

A component of the project's package directories is deployed with the files: a reference to it is kept, even when the org doesn't have it yet. Standard objects, fields, tabs and applications are always kept. When the org can't list a type, its references are kept and a warning says so.

Aligned types: Profile, PermissionSet, MutingPermissionSet and PermissionSetGroup (field, object, class, page, flow, application, tab, record type, layout, custom permission and external data source accesses, user permissions, permission sets of a group), Translations (applications, labels, tabs, flows, report types) and CustomObjectTranslation (field sets, layouts, record types, validation rules, field translations). A field translation file whose field is missing is deleted. An object translation whose object is missing is left as is, with a warning.

Run with --dry-run first to see what would be removed.

# flags.target-org.summary

Org the files will be deployed to.

# flags.api-version.summary

API version of the calls that list the components of the org.

# flags.source-dir.summary

File or directory to align.

# flags.source-dir.description

Defaults to the project's package directories. Can be specified multiple times. Typically the output of sf df git delta.

# flags.dry-run.summary

Show what would be removed without changing any file.

# spinner.start

Listing the components of %s

# warning.unlisted

%s couldn't be listed in the org, its references were kept: %s

# warning.missingObject

%s "%s" translates an object the org lacks: it was left as is and won't deploy.

# warning.unreadable

%s "%s" couldn't be read as a metadata file: it was left as is.

# warning.noDefaultApplication

%s "%s" lost its default application, missing from the org, and the org has no default application for it: set one before deploying.

# info.defaultApplication

The default application of the profile "%s" is missing from the org: "%s", its default application in the org, is the default instead.

# info.aligned

Nothing to remove: every reference exists in the org or in the project.

# info.removed

%s entries removed from %s files.

# info.dryRun

%s entries would be removed from %s files (dry run: no file changed).

# examples

- Show what would be removed from the project's files before deploying to the org "uat":

  <%= config.bin %> <%= command.id %> --target-org uat --dry-run

- Align the files of a delta before deploying it:

  <%= config.bin %> <%= command.id %> --target-org uat --source-dir delta
