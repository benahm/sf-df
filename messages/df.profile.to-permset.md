# summary

Move the accesses of profiles to permission sets.

# description

For each profile, writes a permission set that grants the same accesses: applications, Apex classes, custom metadata types, custom permissions, custom settings, external data sources, fields, flows, objects, Visualforce pages, record types, tabs and user permissions. Entries that grant nothing are not copied. The profile keeps what a permission set can't hold: its license, layout assignments, default application and record types, login hours, IP ranges and other settings.

The moved accesses are then revoked on the profile: each entry is kept, set to false (Hidden for a tab), because a deployment never revokes an access the profile doesn't mention. The default application and the default record types stay visible on the profile. A standard profile keeps its object and user permissions, which Salesforce doesn't let change.

Nothing is sent to an org. Deploy in two steps, so that users keep their accesses: first the permission set, then assign it to the users of the profile, then deploy the profile.

Works best on a complete profile, as written by sf df profile retrieve: the permission set only holds the accesses found in the file.

# flags.source-dir.summary

Profile file, or folder containing profiles, to convert.

# flags.source-dir.description

Every profile found in these files or folders is converted. Can be specified multiple times.

# flags.name.summary

API name of the permission set. Defaults to the profile name, letters and digits only.

# flags.name.description

Only when a single profile is converted.

# flags.label.summary

Label of the permission set. Defaults to the profile name. Only when a single profile is converted.

# flags.output-dir.summary

Directory where the permission sets are written. Defaults to the permissionsets folder next to the profiles folder.

# flags.keep-profile.summary

Leave the profiles as they are: only write the permission sets.

# flags.keep-profile.description

The first step of a migration: deploy the permission sets and assign them, then run the command again without --keep-profile to revoke the accesses on the profiles. The permission set written by the first run is kept when the profile hasn't changed since.

# permissionSet.description

Accesses of the %s profile, moved by sf df profile to-permset.

# warning.standardProfile

Profile "%s" is a standard profile: its object and user permissions were copied but not revoked.

# warning.deployOrder

Deploy the permission sets and assign them to the users of the profiles before deploying the profiles: the profiles no longer grant the moved accesses.

# error.noProfile

No profile found in %s.

# error.nameNeedsOneProfile

--name and --label need a single profile, %s were found.

# error.permissionSetExists

Permission set "%s" already exists with other accesses: %s. Choose another name with --name, or delete the file.

# examples

- Move the accesses of the Sales profile to a Sales permission set, and revoke them on the profile:

  <%= config.bin %> <%= command.id %> --source-dir force-app/main/default/profiles/Sales.profile-meta.xml

- Choose the name and label of the permission set:

  <%= config.bin %> <%= command.id %> --source-dir force-app/main/default/profiles/Sales.profile-meta.xml --name Sales_Access --label "Sales access"

- Only write the permission sets of every profile of a folder, leaving the profiles as they are:

  <%= config.bin %> <%= command.id %> --source-dir force-app/main/default/profiles --keep-profile
