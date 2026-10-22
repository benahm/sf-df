# summary

Retrieve complete profiles, with every access they grant.

# description

`sf project retrieve start` only returns the parts of a profile that relate to the components retrieved with it: retrieving a profile alone gives its user permissions, but not its field, object, class, page, tab, application or record type accesses. This command reads each profile with the Metadata API readMetadata call, which returns the whole profile, and writes it in the same layout as `sf project retrieve start`.

The profiles are chosen with the flags of `sf project retrieve start`: --source-dir, --metadata or --manifest, which are mutually exclusive. Without any of them, every profile of the project's package directories is retrieved. Wildcards in --metadata and --manifest are resolved against the org. A profile already in the project is overwritten in place, a new one is written to the default package directory, unless --output-dir is set. A profile that doesn't exist in the org is reported and no file is written for it.

The API version is, in order: --api-version, the sourceApiVersion of sfdx-project.json, the org's version. The content of a profile depends on it.

Replaces sfdx mdt:profile:retrieve.

# flags.api-version.summary

API version of the readMetadata calls. Defaults to the sourceApiVersion of sfdx-project.json.

# flags.source-dir.summary

Profile file, or folder containing profiles, to retrieve.

# flags.source-dir.description

Every profile found in these files or folders is retrieved, and only those. Other files are ignored. Can be specified multiple times. Replaces --sourcepath of sfdx mdt:profile:retrieve.

# flags.metadata.summary

Profiles to retrieve, as Profile or Profile:Name.

# flags.metadata.description

Profile alone retrieves every profile of the org. A name can hold the * wildcard, for example "Profile:Sales*", matched against the profiles of the org. Can be specified multiple times. Only the Profile type is accepted.

# flags.manifest.summary

File path for the manifest (package.xml) that lists the profiles to retrieve.

# flags.manifest.description

Only the Profile members are retrieved, the other types of the manifest are ignored. A * member retrieves every profile of the org.

# flags.output-dir.summary

Directory where the retrieved profiles are written, in a profiles subdirectory.

# flags.output-dir.description

Profiles are written to <output-dir>/profiles, as `sf project retrieve start --output-dir` writes them. When omitted, the profiles of the project are overwritten. Replaces --outputdir of sfdx mdt:profile:retrieve.

# spinner.start

Retrieving profiles (API version %s)

# spinner.success

Done

# spinner.partial

Done with errors

# warning.notFound

Profile "%s" doesn't exist in the org: no file was written for it.

# warning.failed

Profile "%s" couldn't be retrieved: %s

# error.noProfile

No profile found in %s.

# error.notProfile

"%s" isn't a profile: --metadata only accepts Profile or Profile:Name.

# examples

- Retrieve every profile of the project from the default org, overwriting the files:

  <%= config.bin %> <%= command.id %>

- Retrieve the profiles of a folder:

  <%= config.bin %> <%= command.id %> --source-dir force-app/main/default/profiles

- Retrieve one profile, and the profiles whose name starts with Sales, from a given org:

  <%= config.bin %> <%= command.id %> --metadata Profile:Admin --metadata "Profile:Sales*" --target-org my-sandbox

- Retrieve the profiles listed in a manifest into another folder:

  <%= config.bin %> <%= command.id %> --manifest manifest/package.xml --output-dir retrieved
