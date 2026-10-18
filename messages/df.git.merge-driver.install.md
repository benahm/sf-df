# summary

Merge Salesforce metadata XML by key instead of line by line.

# description

Installs the "deltaforce" git merge driver in the current repository. Container metadata (Profile, PermissionSet, CustomLabels, Translations, CustomObjectTranslation, Workflow, SharingRules, AssignmentRules, AutoResponseRules, EscalationRules, MatchingRules) is then merged element by element, using the key of each item: the field of a fieldPermissions, the fullName of a label. Two branches that change different items of the same file no longer conflict, even when the items are next to each other. A conflict is only reported when both branches changed the same item differently, and the markers surround that item alone.

The driver is declared in the local git config, which is not versioned: every clone runs this command once. The files it handles are declared in .gitattributes with "merge=deltaforce": commit it so the whole team uses the driver. Running the command again only adds what is missing.

Files that can't be merged by key (not well-formed, duplicate keys) are merged line by line, as git does by default.

# info.driver

Merge driver "deltaforce" configured: %s

# info.added

%s: added %s. Commit it so the team uses the driver.

# info.upToDate

%s already declares every file handled by the driver.

# examples

- Install the merge driver in the current repository:

  <%= config.bin %> <%= command.id %>
