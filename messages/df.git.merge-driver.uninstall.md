# summary

Remove the Salesforce metadata merge driver.

# description

Removes the "deltaforce" merge driver from the local git config, and the "merge=deltaforce" lines from .gitattributes. Other lines of .gitattributes are kept; the file is deleted when nothing else is left in it.

# info.removed

Merge driver removed; %s pattern(s) removed from %s.

# examples

- Remove the merge driver from the current repository:

  <%= config.bin %> <%= command.id %>
