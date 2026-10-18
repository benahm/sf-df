---
title: Getting started
---

## Requirements

- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`).
- git 2.40 or later, for `sf df deploy`.
- A Salesforce DX project (`sfdx-project.json`) in a git repository.

## Install

```bash
sf plugins install sf-df@beta
```

The plugin is not signed by Salesforce, so `sf` asks you to confirm the installation. In CI, add `sf-df` to
`~/.config/sf/unsignedPluginAllowList.json` to skip the question:

```json
["sf-df"]
```

Update with `sf plugins update`.

## Map each org to its branch

`sf df deploy` delivers to an org through its branch: the tip of the branch is what the org holds. Map each org once,
from the root of the repository:

```bash
sf df org map --target-org int --branch int
sf df org map --target-org uat --branch uat
```

The org URL is read from the connection and stored in `sfdx-project.json`:

```json
"plugins": {
  "sfdf": {
    "orgs": [
      { "url": "https://example--int.sandbox.my.salesforce.com", "branch": "int" },
      { "url": "https://example--uat.sandbox.my.salesforce.com", "branch": "uat" }
    ]
  }
}
```

An org is identified by its My Domain URL, not by its alias: aliases differ from one machine to another, the URL is the
same for everyone and survives a sandbox refresh. Commit `sfdx-project.json` so the team and the CI share the mapping.

Run `sf df org map` alone to show it, with the local alias of each org:

```text
Branch  Org URL                                          Local alias
int     https://example--int.sandbox.my.salesforce.com   int
uat     https://example--uat.sandbox.my.salesforce.com   (not authenticated)
```

## Protect the branches

Only `sf df deploy` must push to a mapped branch: otherwise the branch gets ahead of the org without the command
knowing. Protect each mapped branch in your forge so that only the CI can push to it. Pull requests to these branches
are still used for review; the CI delivers them.

## First delivery

See what would be deployed, without deploying or pushing anything:

```bash
sf df deploy --source feature/JIRA-123 --target-org int --dry-run
```

```text
Merge of feature/JIRA-123 into int: 3f2a91c
Delta: 4 component(s) to deploy, 0 to delete
Tests: RunSpecifiedTests (InvoiceTest)
```

Then deliver:

```bash
sf df deploy --source feature/JIRA-123 --target-org int
```

If the org doesn't match its branch yet (first use on an existing org), start the delta from the commit that describes
the org with `--from`. See [Deliver a branch](./guides/deliver-a-branch.mdx).
