import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';

import OrgMap from '../../../../src/commands/df/org/map.js';

describe('df org map', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  const initialCwd = process.cwd();
  let repoRoot: string;

  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    testOrg.instanceUrl = 'https://example--int.sandbox.my.salesforce.com';
    await $$.stubAuths(testOrg);
    repoRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-org-map-command-'));
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    await writeFile(
      path.join(repoRoot, 'sfdx-project.json'),
      '{\n  "packageDirectories": [{ "path": "force-app" }]\n}\n'
    );
    process.chdir(repoRoot);
  });

  afterEach(async () => {
    process.chdir(initialCwd);
    $$.restore();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('maps the org of --target-org to the branch, by its URL', async () => {
    const result = await OrgMap.run(['--target-org', testOrg.username, '--branch', 'int']);

    expect(result.action).to.equal('mapped');
    const project = JSON.parse(await readFile(path.join(repoRoot, 'sfdx-project.json'), 'utf8')) as {
      plugins: { sfdf: { orgs: unknown } };
    };
    expect(project.plugins.sfdf.orgs).to.deep.equal([
      { url: 'https://example--int.sandbox.my.salesforce.com', branch: 'int' },
    ]);
  });

  it('shows the mapping without --branch, and changes nothing', async () => {
    await OrgMap.run(['--target-org', testOrg.username, '--branch', 'int']);

    const result = await OrgMap.run([]);

    expect(result.action).to.equal('list');
    expect(result.orgs.map((org) => [org.branch, org.url])).to.deep.equal([
      ['int', 'https://example--int.sandbox.my.salesforce.com'],
    ]);
  });

  it('removes the org with --remove', async () => {
    await OrgMap.run(['--target-org', testOrg.username, '--branch', 'int']);

    const result = await OrgMap.run(['--target-org', testOrg.username, '--remove']);

    expect(result).to.deep.include({ action: 'removed', previousBranch: 'int', orgs: [] });
  });
});
