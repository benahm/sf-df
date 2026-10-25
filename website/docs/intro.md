---
title: What is Deltaforce?
sidebar_label: Introduction
slug: /
---

Deltaforce (`sf df`) is a [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) plugin that delivers
a git branch to a Salesforce org **in one command**:

```bash
sf df deploy --source feature/JIRA-123 --target-org int
```

It merges the feature into the branch of the org, deploys only what changed, and pushes the merge **only if the
deployment succeeded**. The branch of an org always describes what the org holds.

## Why

Between hand-written CI scripts around a delta tool and complete DevOps frameworks, Deltaforce stays light:

- **One command to deliver.** No chain of commands to assemble in each pipeline.
- **No branching model imposed.** Cascade (`int` → `uat` → `main`), promotion per ticket or a `release` branch: each
  org is simply mapped to one branch.
- **No pull request or merge management.** That is the job of your forge (GitHub, GitLab, Azure DevOps).
- **No wrapper around commands that already work.** `sf project deploy quick` stays `sf project deploy quick`.

## What is inside

| Command | What it does |
| --- | --- |
| [`sf df deploy`](./commands/df-deploy.md) | Merge a branch into the branch of an org, deploy the delta, push only on success. |
| [`sf df org map`](./commands/df-org-map.md) | Map each org to its branch, once, in `sfdx-project.json`. |
| [`sf df git delta`](./commands/df-git-delta.md) | Build an incremental deployment from a git diff. Replaces `sfdx mdt:git:delta`. |
| [`sf df git merge-driver install`](./commands/df-git-merge-driver-install.md) | Merge profiles, permission sets, labels and translations item by item instead of line by line. |
| [`sf df profile retrieve`](./commands/df-profile-retrieve.md) | Retrieve complete profiles, ready to deploy. Replaces `sfdx mdt:profile:retrieve`. |
| [`sf df profile to-permset`](./commands/df-profile-to-permset.md) | Move the accesses of a profile to a permission set and revoke them on the profile. |
| [`sf df org align`](./commands/df-org-align.md) | Remove from profiles, permission sets and translations the references to components the target org lacks. Replaces the `adapt` commands of sfdx-mdt-plugin. |

## Principles

- **The delta is minimal.** Only what changed is deployed, plus the files Salesforce requires for the deployment to
  pass.
- **A deployment never deletes more than git did.** When in doubt, a warning rather than a deletion.
- **A deployment is atomic.** Package and deletions go in one job: one rejected component rolls everything back.
- **Verified in an org, not by reasoning.** Deletion rules come from real sandbox deployments and are covered by tests.

Next: [Getting started](./getting-started.md).
