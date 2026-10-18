# summary

Merge three versions of a Salesforce metadata file by key (called by git).

# description

git runs this command for the files declared with "merge=deltaforce" in .gitattributes, once `sf df git merge-driver install` has configured the driver. It writes the merged file in place of --current and exits with code 1 when conflicts are left, so git reports the file as conflicted.

Container metadata is merged element by element, using the key of each item; conflict markers surround only the items both sides changed differently. Files that can't be merged by key are merged line by line with `git merge-file`.

# flags.ancestor.summary

Common ancestor version of the file, given by git.

# flags.current.summary

Current branch version of the file, given by git.

# flags.current.description

Receives the merged result.

# flags.other.summary

Other branch version of the file, given by git.

# flags.marker-size.summary

Length of the conflict markers, given by git.

# flags.path.summary

Path of the file in the repository, used in messages.

# warning.conflicts

%s conflict(s) left in %s.

# examples

- Merge three versions of a profile, as git does:

  <%= config.bin %> <%= command.id %> --ancestor base.xml --current ours.xml --other theirs.xml --path force-app/main/default/profiles/Admin.profile-meta.xml
