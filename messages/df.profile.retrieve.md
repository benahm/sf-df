# summary

Retrieve complete profiles, with every access they grant.

# description

`sf project retrieve start` only returns the parts of a profile that relate to the components retrieved with it: retrieving a profile alone gives its user permissions, but not its field, object, class, page, tab, application or record type accesses. This command reads each profile with the Metadata API readMetadata call, which returns the whole profile, and writes it in the same layout as `sf project retrieve start`.

Profiles are found in the source file or folder given by --source-dir and are overwritten in place, unless --output-dir is set. A profile that doesn't exist in the org is reported and its file is left untouched.

The API version is, in order: --api-version, the sourceApiVersion of sfdx-project.json, the org's version. The content of a profile depends on it.

Replaces sfdx mdt:profile:retrieve.

# flags.source-dir.summary

Profile file, or folder containing profiles, to retrieve.

# flags.source-dir.description

Every profile found in this file or folder is retrieved, and only those. Other files are ignored. Replaces --sourcepath of sfdx mdt:profile:retrieve.

# flags.output-dir.summary

Directory where the retrieved profiles are written.

# flags.output-dir.description

When omitted, the profiles found in --source-dir are overwritten. Replaces --outputdir of sfdx mdt:profile:retrieve.

# spinner.start

Retrieving profiles (API version %s)

# spinner.success

Done

# spinner.partial

Done with errors

# warning.notFound

Profile "%s" doesn't exist in the org: its file was left untouched.

# warning.failed

Profile "%s" couldn't be retrieved: %s

# error.noProfile

No profile found in %s.

# examples

- Retrieve every profile of the project from the default org, overwriting the files:

  <%= config.bin %> <%= command.id %> --source-dir force-app/main/default/profiles

- Retrieve one profile from a given org into another folder:

  <%= config.bin %> <%= command.id %> --source-dir "force-app/main/default/profiles/Admin.profile-meta.xml" --target-org my-sandbox --output-dir retrieved
