# summary

Map an org to its branch for sf df deploy, or show the mapping.

# description

sf df deploy delivers to an org through its branch: the branch tip is what the org holds. The mapping is stored in sfdx-project.json ("plugins.sfdf.orgs"), shared by the team, with the org identified by its My Domain URL: aliases differ between machines, the URL doesn't, even after a sandbox refresh.

With --branch, maps the org of --target-org to the branch: its URL is read from the org, never typed. A branch belongs to one org only. With --remove, removes the org from the mapping. Without either, shows the mapping, with the local alias of each org when it is authenticated on this machine.

Only "plugins.sfdf.orgs" is changed: the rest of sfdx-project.json keeps its content and indentation. Commit it so the team and the CI share the mapping.

# flags.target-org.summary

Org to map or remove. Its URL is what is stored.

# flags.branch.summary

Branch that holds the content of the org.

# flags.branch.description

Adds the org to the mapping, or changes its branch. Fails when the branch is already mapped to another org.

# flags.remove.summary

Remove the org from the mapping.

# error.noOrg

--branch and --remove need an org: pass --target-org, or set a default org.

# info.mapped

%s mapped to the branch "%s" in %s. Commit it so the team uses the mapping.

# info.remapped

%s mapped to the branch "%s" instead of "%s" in %s. Commit it so the team uses the mapping.

# info.unchanged

%s is already mapped to the branch "%s".

# info.removed

%s (branch "%s") removed from %s.

# info.empty

No org mapped yet. Map one with: sf df org map --target-org <org> --branch <branch>

# info.notAuthenticated

(not authenticated)

# examples

- Map the org "int" to the branch int:

  <%= config.bin %> <%= command.id %> --target-org int --branch int

- Show the mapping:

  <%= config.bin %> <%= command.id %>

- Remove an org from the mapping:

  <%= config.bin %> <%= command.id %> --target-org int --remove
