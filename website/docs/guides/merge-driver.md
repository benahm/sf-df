---
title: Merge metadata by key
---

git merges Profiles, Permission Sets, Custom Labels or Translations line by line: two branches that add a field
permission or a label at the same place conflict, and a conflict often spans many unrelated elements. These files are
sets of items identified by a key (the `field` of a `fieldPermissions`, the `fullName` of a label): they can be merged
item by item.

```bash
# Once per clone: configures the driver and declares the files it handles in .gitattributes
sf df git merge-driver install
git add .gitattributes && git commit -m "Merge Salesforce metadata by key"
```

## Behaviour

- Changes to different items never conflict, even when the items are next to each other.
- Both sides changed the same item differently: conflict markers surround that item only.
- One side deleted an item the other changed: conflict. Deleted and unchanged: deleted.
- Added items keep the order of the file; two sorted files give a sorted file.
- Files that can't be merged by key (not well-formed, duplicate keys) fall back to git's line merge.

Handled: Profile, PermissionSet, CustomLabels, Translations, CustomObjectTranslation, Workflow, SharingRules,
AssignmentRules, AutoResponseRules, EscalationRules, MatchingRules.

## How it is wired

1. `install` declares the `deltaforce` driver in the **local** git config, which is not versioned: each clone runs the
   command once.
2. It adds one `<pattern> merge=deltaforce` line per handled type to `.gitattributes`. That file is versioned: commit it
   so the whole team uses the driver. A machine without the driver keeps git's line merge.
3. git then calls [`sf df git merge-driver run`](../commands/df-git-merge-driver-run.md) for each file changed on both
   sides.

`sf df git merge-driver uninstall` removes the driver and its lines.

[`sf df deploy`](./deliver-a-branch.mdx) uses the driver without any install: it passes it to `git merge-tree` and reads
`.gitattributes` from the branch of the org.
