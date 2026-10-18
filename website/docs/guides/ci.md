---
title: CI setup
---

The CI runs `sf df deploy`, so it needs:

- the Salesforce CLI and the plugin;
- a connection to the org, from an SFDX auth URL stored as a secret;
- the full git history (`fetch-depth: 0`) and the right to push to the branch of the org;
- one delivery at a time per org.

`sf` calls `sf df git merge-driver run` during the merge: the plugin must be on the `PATH` of the job, which a global
install does. No `merge-driver install` is needed in the CI.

## GitHub Actions

Deliver a branch to `int` on demand:

```yaml
name: deliver to int
on:
  workflow_dispatch:
    inputs:
      source:
        description: Branch to deliver
        required: true

concurrency: deliver-int

jobs:
  deliver:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: npm install --global @salesforce/cli
      - run: |
          mkdir -p ~/.config/sf
          echo '["sf-df"]' > ~/.config/sf/unsignedPluginAllowList.json
          sf plugins install sf-df@beta
      - run: |
          echo "${{ secrets.SFDX_AUTH_URL_INT }}" > auth.txt
          sf org login sfdx-url --sfdx-url-file auth.txt --alias int
          rm auth.txt
      - run: |
          git config user.name "github-actions"
          git config user.email "github-actions@users.noreply.github.com"
          sf df deploy --source "${{ inputs.source }}" --target-org int
```

If the branch is protected, allow the token of the workflow (or a dedicated GitHub App) to bypass the protection: it
is the only one allowed to push to `int`.

### Validate pull requests

Check each pull request against the org without changing it:

```yaml
on:
  pull_request:
    branches: [int]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      # same setup steps as above
      - run: sf df deploy --source "${{ github.head_ref }}" --target-org int --validate
```

## GitLab CI

```yaml
deliver-int:
  image: node:22
  resource_group: deliver-int
  when: manual
  variables:
    GIT_DEPTH: 0
  script:
    - npm install --global @salesforce/cli
    - mkdir -p ~/.config/sf && echo '["sf-df"]' > ~/.config/sf/unsignedPluginAllowList.json
    - sf plugins install sf-df@beta
    - echo "$SFDX_AUTH_URL_INT" > auth.txt && sf org login sfdx-url --sfdx-url-file auth.txt --alias int && rm auth.txt
    - git config user.name "gitlab-ci" && git config user.email "gitlab-ci@example.com"
    - git remote set-url origin "https://oauth2:${PUSH_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git"
    - sf df deploy --source "$SOURCE_BRANCH" --target-org int
```

`resource_group` runs one delivery at a time. `PUSH_TOKEN` is a project access token allowed to push to the
protected branch.
