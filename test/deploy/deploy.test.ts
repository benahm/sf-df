import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { parseDeployConfig, type DeployConfig } from '../../src/deploy/config.js';
import { deployBranch, type DeployBranchOptions } from '../../src/deploy/deploy.js';
import type { DeployOutcome, DeployRequest } from '../../src/deploy/salesforce.js';

const ORG_URL = 'https://example--int.sandbox.my.salesforce.com';
const CONFIG: DeployConfig = parseDeployConfig({
  plugins: { sfdf: { orgs: [{ url: ORG_URL, branch: 'int' }] } },
});
const SOURCE = 'force-app/main/default';

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const classMeta =
  '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>61.0</apiVersion><status>Active</status></ApexClass>\n';

const labels = (...names: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n${names
    .map(
      (name) =>
        `    <labels>\n        <fullName>${name}</fullName>\n        <language>en_US</language>\n        <protected>false</protected>\n        <shortDescription>${name}</shortDescription>\n        <value>${name}</value>\n    </labels>\n`
    )
    .join('')}</CustomLabels>\n`;

type Repo = { remote: string; dev: string; ci: string; root: string };

const write = async (repo: string, relativePath: string, content: string): Promise<void> => {
  const file = path.join(repo, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
};

const commitAll = (repo: string, message: string): string => {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
};

const remoteTip = (repo: Repo, branch: string): string => git(repo.remote, ['rev-parse', `refs/heads/${branch}`]);

const fakeDeployer = (outcome: Partial<DeployOutcome> = {}, onDeploy?: (request: DeployRequest) => void) => {
  const requests: DeployRequest[] = [];
  return {
    requests,
    deployer: async (request: DeployRequest): Promise<DeployOutcome> => {
      requests.push(request);
      onDeploy?.(request);
      return {
        id: '0Af000000000001',
        success: true,
        status: 'Succeeded',
        componentFailures: [],
        testFailures: [],
        ...outcome,
      };
    },
  };
};

describe('deploy', () => {
  let repo: Repo;

  const options = (
    overrides: Partial<DeployBranchOptions> & Pick<DeployBranchOptions, 'deployer'>
  ): DeployBranchOptions => ({
    repoRoot: repo.ci,
    config: CONFIG,
    orgUrl: ORG_URL,
    source: 'feature/b',
    ...overrides,
  });

  // A bare remote, a developer clone that pushes `int` and `feature/b`, and a CI clone that runs the command.
  beforeEach(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-df-deploy-'));
    repo = {
      root,
      remote: path.join(root, 'remote.git'),
      dev: path.join(root, 'dev'),
      ci: path.join(root, 'ci'),
    };
    git(root, ['init', '-q', '--bare', '-b', 'int', repo.remote]);
    git(root, ['clone', '-q', repo.remote, repo.dev]);
    git(repo.dev, ['config', 'user.email', 'dev@example.com']);
    git(repo.dev, ['config', 'user.name', 'Dev']);
    git(repo.dev, ['config', 'core.autocrlf', 'false']);
    git(repo.dev, ['checkout', '-q', '-b', 'int']);

    await write(
      repo.dev,
      'sfdx-project.json',
      JSON.stringify({
        packageDirectories: [{ path: 'force-app', default: true }],
        sourceApiVersion: '61.0',
      })
    );
    await write(repo.dev, `${SOURCE}/classes/Invoice.cls`, 'public class Invoice {}\n');
    await write(repo.dev, `${SOURCE}/classes/Invoice.cls-meta.xml`, classMeta);
    await write(repo.dev, `${SOURCE}/classes/InvoiceTest.cls`, '@IsTest class InvoiceTest {}\n');
    await write(repo.dev, `${SOURCE}/classes/InvoiceTest.cls-meta.xml`, classMeta);
    await write(repo.dev, `${SOURCE}/classes/Legacy.cls`, 'public class Legacy {}\n');
    await write(repo.dev, `${SOURCE}/classes/Legacy.cls-meta.xml`, classMeta);
    await write(repo.dev, `${SOURCE}/labels/CustomLabels.labels-meta.xml`, labels('Hello'));
    commitAll(repo.dev, 'base');
    git(repo.dev, ['push', '-q', 'origin', 'int']);

    git(repo.dev, ['checkout', '-q', '-b', 'feature/b']);
    await write(repo.dev, `${SOURCE}/classes/Invoice.cls`, 'public class Invoice { Integer total; }\n');
    commitAll(repo.dev, 'feature b');
    git(repo.dev, ['push', '-q', 'origin', 'feature/b']);
    git(repo.dev, ['checkout', '-q', 'int']);

    git(root, ['clone', '-q', repo.remote, repo.ci]);
  });

  afterEach(async () => {
    await rm(repo.root, { recursive: true, force: true });
  });

  it('deploys the delta of the merge, then pushes the merge to the branch of the org', async () => {
    const base = remoteTip(repo, 'int');
    const { deployer, requests } = fakeDeployer();

    const result = await deployBranch(options({ deployer }));

    expect(result.status).to.equal('deployed');
    expect(result.base).to.equal(base);
    expect(result.components).to.deep.equal(['ApexClass:Invoice']);
    expect(result.deletions).to.deep.equal([]);
    expect(result.testLevel).to.equal('RunSpecifiedTests');
    expect(result.tests).to.deep.equal(['InvoiceTest']);
    expect(requests).to.have.length(1);
    expect(requests[0].checkOnly).to.equal(false);
    // The merge commit joins the branch and the feature, and the branch now points to it.
    expect(remoteTip(repo, 'int')).to.equal(result.commit);
    expect(result.pushed).to.equal(true);
    expect(git(repo.remote, ['rev-list', '--parents', '-n', '1', result.commit]).split(' ')).to.deep.equal([
      result.commit,
      base,
      remoteTip(repo, 'feature/b'),
    ]);
  });

  it('pushes nothing when the deployment fails: the branch still matches the org', async () => {
    const base = remoteTip(repo, 'int');
    const { deployer } = fakeDeployer({
      success: false,
      status: 'Failed',
      componentFailures: ['ApexClass:Invoice Invalid type'],
    });

    let error: Error | undefined;
    try {
      await deployBranch(options({ deployer }));
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).to.contain('Nothing was pushed').and.to.contain('ApexClass:Invoice Invalid type');
    expect(remoteTip(repo, 'int')).to.equal(base);
  });

  it('stops on a conflict without deploying', async () => {
    await write(repo.dev, `${SOURCE}/classes/Invoice.cls`, 'public class Invoice { String name; }\n');
    commitAll(repo.dev, 'other change on int');
    git(repo.dev, ['push', '-q', 'origin', 'int']);
    const { deployer, requests } = fakeDeployer();

    let error: Error | undefined;
    try {
      await deployBranch(options({ deployer }));
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).to.contain('conflicts with int').and.to.contain(`${SOURCE}/classes/Invoice.cls`);
    expect(requests).to.have.length(0);
  });

  it('merges the files declared in .gitattributes of the branch with the XML merge driver', async () => {
    // Both sides add a label at the same place: a line merge conflicts, the driver doesn't.
    await write(repo.dev, '.gitattributes', '*.labels-meta.xml merge=deltaforce\n');
    await write(repo.dev, `${SOURCE}/labels/CustomLabels.labels-meta.xml`, labels('Hello', 'FromInt'));
    commitAll(repo.dev, 'label on int');
    git(repo.dev, ['push', '-q', 'origin', 'int']);
    git(repo.dev, ['checkout', '-q', 'feature/b']);
    await write(repo.dev, `${SOURCE}/labels/CustomLabels.labels-meta.xml`, labels('Hello', 'FromFeature'));
    commitAll(repo.dev, 'label on feature');
    git(repo.dev, ['push', '-q', 'origin', 'feature/b']);

    // Stands for `sf df git merge-driver run`: writes the merged labels into %A.
    const driver = path.join(repo.root, 'driver.cjs');
    await writeFile(
      driver,
      `require('node:fs').writeFileSync(process.argv[2], ${JSON.stringify(
        labels('Hello', 'FromFeature', 'FromInt')
      )});\n`
    );
    const { deployer } = fakeDeployer();

    const result = await deployBranch(
      options({ deployer, driverCommand: `node "${driver.replaceAll('\\', '/')}" %A` })
    );

    expect(result.status).to.equal('deployed');
    expect(git(repo.ci, ['show', `${result.commit}:${SOURCE}/labels/CustomLabels.labels-meta.xml`]))
      .to.contain('FromInt')
      .and.to.contain('FromFeature');
    expect(result.components).to.include('CustomLabels:CustomLabels');
  });

  it('refuses deletions without --allow-destructive', async () => {
    git(repo.dev, ['checkout', '-q', 'feature/b']);
    git(repo.dev, ['rm', '-q', `${SOURCE}/classes/Legacy.cls`, `${SOURCE}/classes/Legacy.cls-meta.xml`]);
    commitAll(repo.dev, 'remove legacy');
    git(repo.dev, ['push', '-q', 'origin', 'feature/b']);
    const base = remoteTip(repo, 'int');
    const refused = fakeDeployer();

    let error: Error | undefined;
    try {
      await deployBranch(options({ deployer: refused.deployer }));
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).to.contain('deletes 1 component(s)').and.to.contain('ApexClass:Legacy');
    expect(refused.requests).to.have.length(0);
    expect(remoteTip(repo, 'int')).to.equal(base);

    const allowed = fakeDeployer();
    const result = await deployBranch(options({ deployer: allowed.deployer, allowDestructive: true }));
    expect(result.deletions).to.deep.equal(['ApexClass:Legacy']);
    expect(allowed.requests[0].destructiveManifest).to.be.a('string');
  });

  it('deploys nothing and pushes nothing in dry run', async () => {
    const base = remoteTip(repo, 'int');
    const { deployer, requests } = fakeDeployer();

    const result = await deployBranch(options({ deployer, dryRun: true }));

    expect(result.status).to.equal('dryRun');
    expect(result.components).to.deep.equal(['ApexClass:Invoice']);
    expect(requests).to.have.length(0);
    expect(remoteTip(repo, 'int')).to.equal(base);
  });

  it('validates without pushing', async () => {
    const base = remoteTip(repo, 'int');
    const { deployer, requests } = fakeDeployer();

    const result = await deployBranch(options({ deployer, validate: true }));

    expect(result.status).to.equal('validated');
    expect(requests[0].checkOnly).to.equal(true);
    expect(remoteTip(repo, 'int')).to.equal(base);
  });

  it('reports a deployed merge that could not be pushed because the branch moved', async () => {
    // Someone pushes to int while the deployment runs.
    const { deployer } = fakeDeployer({}, () => {
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'direct push'], {
        cwd: repo.dev,
      });
      execFileSync('git', ['push', '-q', 'origin', 'int'], { cwd: repo.dev });
    });

    let error: Error | undefined;
    try {
      await deployBranch(options({ deployer }));
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).to.contain('org is ahead of its branch');
  });

  it('starts the delta from --from, after a sandbox refresh', async () => {
    const { deployer } = fakeDeployer();
    const first = git(repo.ci, ['rev-list', '--max-parents=0', 'origin/int']);
    await write(repo.dev, `${SOURCE}/classes/Report.cls`, 'public class Report {}\n');
    await write(repo.dev, `${SOURCE}/classes/Report.cls-meta.xml`, classMeta);
    commitAll(repo.dev, 'report');
    git(repo.dev, ['push', '-q', 'origin', 'int']);

    const result = await deployBranch(options({ deployer, from: first }));

    expect(result.from).to.equal(first);
    expect(result.components).to.deep.equal(['ApexClass:Invoice', 'ApexClass:Report']);
  });

  it('only pushes when the merge holds no metadata change', async () => {
    git(repo.dev, ['checkout', '-q', 'feature/b']);
    git(repo.dev, ['reset', '-q', '--hard', 'int']);
    await write(repo.dev, 'README.md', '# Project\n');
    commitAll(repo.dev, 'readme');
    git(repo.dev, ['push', '-q', '-f', 'origin', 'feature/b']);
    const { deployer, requests } = fakeDeployer();

    const result = await deployBranch(options({ deployer }));

    expect(result.status).to.equal('nothingToDeploy');
    expect(requests).to.have.length(0);
    expect(remoteTip(repo, 'int')).to.equal(result.commit);
  });

  it('refuses an org that is not declared in the configuration', async () => {
    const { deployer } = fakeDeployer();

    let error: Error | undefined;
    try {
      await deployBranch(options({ deployer, orgUrl: 'https://example--uat.sandbox.my.salesforce.com' }));
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).to.contain('is not declared in sfdx-project.json');
  });
});
