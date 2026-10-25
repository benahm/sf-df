# summary

List the latest metadata changes made in an org, with their date and author.

# description

Lists the components of the org with the date and author of their last change, newest first: the 20 latest by default, every change since a date with --since. --output-file writes them to a package.xml, to retrieve them.

Dates come from three sources:

- the date and author the Metadata API gives every component;
- source tracking, when the org has it: the only source of deleted components;
- the accesses of the profiles and permission sets of the project: an access changed in Setup moves neither the date of the profile nor source tracking. These changes have no author, and are listed whatever --by says. A revoked access leaves no trace.

Some types have no date (the CustomLabels container, standard objects, settings): their changes show on their children (CustomLabel, the fields of a standard object) or not at all. Components of installed packages and changes made by Automated Process are left out. Types stored in folders (reports, dashboards, documents, email templates) are listed only when asked with --metadata-type.

# flags.target-org.summary

Org whose changes are listed.

# flags.api-version.summary

API version of the calls.

# flags.since.summary

List every change made since this date: 2026-10-20 (local midnight) or 2026-10-20T14:30:00Z.

# flags.since.description

Without --since, the 20 latest changes are listed. With it, every change since the date, unless --limit is set.

# flags.limit.summary

Number of changes listed, newest first.

# flags.limit.description

Defaults to 20 without --since, and to every change with it.

# flags.by.summary

Only list the changes of this user: me, a username, a user Id or a full name.

# flags.by.description

Can be specified multiple times. A full name two users share is refused: give the username. The changes of accesses have no author: they are listed whatever --by says.

# flags.metadata-type.summary

Only list these metadata types, for example ApexClass or CustomField.

# flags.metadata-type.description

Can be specified multiple times. Types stored in folders (Report, Dashboard, Document, EmailTemplate) are listed only with this flag: one call per folder makes them slow.

# flags.output-file.summary

Write the changed components to this package.xml.

# flags.output-file.description

Deleted components are left out: they can't be retrieved. Retrieve the components with `sf project retrieve start --manifest`, then the complete profiles with `sf df profile retrieve --manifest`.

# spinner.start

Listing the changes of %s

# warning.unlisted

These types couldn't be listed, their changes are missing: %s

# info.none

No change found.

# info.accessAuthor

(accesses changed)

# info.noTracking

The org has no source tracking: deleted components aren't listed.

# info.noProject

Outside a project, changes of the accesses of profiles and permission sets aren't listed.

# info.manifest

%s written with %s components. Retrieve them with: sf project retrieve start --manifest %s

# info.manifestProfiles

Then complete the profiles, a native retrieve writes them partial: sf df profile retrieve --manifest %s

# error.since

"%s" isn't a date: use 2026-10-20 or 2026-10-20T14:30:00Z.

# error.unknownUser

No user "%s" in the org: give me, a username, a user Id or a full name.

# error.ambiguousUser

Several users are named "%s": give one of their usernames (%s).

# error.unknownTypes

Not a metadata type of the org: %s.

# examples

- List the 20 latest changes of the org "int":

  <%= config.bin %> <%= command.id %> --target-org int

- List my changes since October 20:

  <%= config.bin %> <%= command.id %> --target-org int --since 2026-10-20 --by me

- List the Apex classes and custom fields changed since October 20:

  <%= config.bin %> <%= command.id %> --target-org int --since 2026-10-20 --metadata-type ApexClass --metadata-type CustomField

- Write the changes since October 20 to a manifest, then retrieve them with complete profiles:

  <%= config.bin %> <%= command.id %> --target-org int --since 2026-10-20 --output-file changes.xml

  sf project retrieve start --manifest changes.xml

  sf df profile retrieve --manifest changes.xml
