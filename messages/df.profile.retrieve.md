# summary

Retrieve complete profiles, with every access they grant.

# description

`sf project retrieve start` only returns the parts of a profile that relate to the components retrieved with it: retrieving a profile alone gives its user permissions, but not its field, object, class, page, tab, application or record type accesses. This command reads each profile with the Metadata API readMetadata call, which returns the whole profile, and writes it in the same layout as `sf project retrieve start`. Retrieve the other metadata types with `sf project retrieve start`, without the profiles, or run this command after it: a native retrieve overwrites a complete profile with a partial one.

The profile is written so that it deploys: the org returns settings for standard tabs it refuses at deployment, and may hold two layout assignments for one record type. Both are left out, with a warning. --entries and --scope choose which accesses are kept.

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

# flags.entries.summary

Profile entries to keep: active (default) or all.

# flags.entries.description

active leaves out the entries that grant nothing (a field neither readable nor editable, a class not enabled...), except those already in the project's file, which keep the org's value. A deployment never revokes an access the profile doesn't mention: an access revoked in the org must stay in the file, set to false. all keeps every entry the org returns. Tab visibilities, layout assignments and the other settings are always kept.

# flags.scope.summary

Components the profile accesses refer to: org (default) or project.

# flags.scope.description

org keeps the accesses to every component of the org. project only keeps the accesses to the components of the project's package directories and to standard components (Account, Account.Name, standard tabs and applications): the profile no longer mentions the fields of managed packages or the components created in the org but not retrieved, so that it deploys to an org that lacks them. Retrieve the profile again after adding a component to the project.

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

# warning.tabs

Profile "%s": %s settings of standard tabs the org doesn't list were left out. The org refuses them at deployment.

# warning.layoutAssignments

Profile "%s": the org assigns two layouts to %s. These assignments were left out, as the org refuses them at deployment: assign one layout in the org, then retrieve the profile again.

# warning.standardTabs

The standard tabs of the org couldn't be listed, every tab setting was kept: %s

# error.scopeNeedsProject

--scope project needs a project: the profiles are filtered on the components of its package directories.

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

- Retrieve the Admin profile with only the accesses to the components of the project:

  <%= config.bin %> <%= command.id %> --metadata Profile:Admin --scope project

- Retrieve the profiles listed in a manifest into another folder:

  <%= config.bin %> <%= command.id %> --manifest manifest/package.xml --output-dir retrieved
