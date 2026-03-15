import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

const thisFilePath = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(thisFilePath), '../..');

const run = (command: string, args: string[], cwd: string): string => {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const cause = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const stdout = cause.stdout ? String(cause.stdout) : '';
    const stderr = cause.stderr ? String(cause.stderr) : '';
    throw new Error(
      [
        `Command failed: ${command} ${args.join(' ')}`,
        cause.message ?? '',
        stdout ? `STDOUT:\n${stdout}` : '',
        stderr ? `STDERR:\n${stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
};

const quoteCmdArg = (arg: string): string => (/[\s"]/u.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg);

const runSf = (args: string[], cwd: string): string => {
  if (process.platform === 'win32') {
    const command = `sf ${args.map(quoteCmdArg).join(' ')}`;
    return run('cmd.exe', ['/d', '/s', '/c', command], cwd);
  }

  return run('sf', args, cwd);
};

const parseJsonOutput = <T>(rawOutput: string): T => {
  const trimmed = rawOutput.trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart < 0) {
    throw new Error(`Expected JSON output but got: ${trimmed}`);
  }

  return JSON.parse(trimmed.slice(jsonStart)) as T;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const createRepoFromFixture = async (scenarioName: string): Promise<string> => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-e2e-org-'));
  const fixtureRoot = path.resolve(pluginRoot, 'test/fixtures/scenarios', scenarioName, 'baseline');

  await cp(fixtureRoot, repoRoot, { recursive: true });
  run('git', ['init'], repoRoot);
  run('git', ['config', 'user.email', 'e2e-org@example.com'], repoRoot);
  run('git', ['config', 'user.name', 'E2E Org Tests'], repoRoot);
  run('git', ['add', '.'], repoRoot);
  run('git', ['commit', '-m', 'base'], repoRoot);

  return repoRoot;
};

const applyScenarioChanges = async (repoRoot: string, scenarioName: string): Promise<void> => {
  const changedRoot = path.resolve(pluginRoot, 'test/fixtures/scenarios', scenarioName, 'changed');
  await cp(changedRoot, repoRoot, { recursive: true });
};

const readScenarioExpectedFile = async (scenarioName: string, relativePath: string): Promise<string> =>
  readFile(path.resolve(pluginRoot, 'test/fixtures/scenarios', scenarioName, 'expected', relativePath), 'utf8');

type SfJsonResult = {
  status: number;
  result?: {
    processedChanges?: number;
    packageManifestPath?: string;
    destructiveManifestPath?: string;
  };
};

const isScratchLimitExceeded = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('LIMIT_EXCEEDED');

describe('e2e org: repo-basic fixture', () => {
  let repoRoot: string | undefined;
  let scratchAlias: string | undefined;
  let createdScratch = false;
  const runE2EOrg = process.env.RUN_E2E_ORG === 'true';
  const keepScratch = process.env.E2E_KEEP_ORG === 'true';
  const devHubAlias = process.env.DEV_HUB_ALIAS ?? 'DevOrg';
  const scratchDurationDays = process.env.SCRATCH_DURATION_DAYS ?? '1';
  const preconfiguredTargetOrg = process.env.E2E_TARGET_ORG;

  before(function () {
    if (!runE2EOrg) {
      this.skip();
    }
  });

  afterEach(async () => {
    if (createdScratch && scratchAlias && !keepScratch) {
      try {
        runSf(['org', 'delete', 'scratch', '--target-org', scratchAlias, '--no-prompt', '--json'], pluginRoot);
      } catch {
        // Deletion is best-effort so the test can still report the original failure.
      }
      scratchAlias = undefined;
    }

    if (repoRoot) {
      try {
        await rm(repoRoot, { recursive: true, force: true });
      } catch {
        // Temp cleanup is best-effort on Windows where file handles can be briefly locked.
      }
      repoRoot = undefined;
    }
  });

  it('creates a scratch org (1 day), deploys baseline, generates delta via plugin, and deploys delta', async function () {
    this.timeout(20 * 60 * 1000);
    repoRoot = await createRepoFromFixture('repo-basic');
    createdScratch = false;
    if (preconfiguredTargetOrg) {
      scratchAlias = preconfiguredTargetOrg;
    } else {
      scratchAlias = `e2e-org-${Date.now()}`;
      try {
        const scratchCreateRaw = runSf(
          [
            'org',
            'create',
            'scratch',
            '--target-dev-hub',
            devHubAlias,
            '--alias',
            scratchAlias,
            '--duration-days',
            scratchDurationDays,
            '--edition',
            'developer',
            '--json',
          ],
          pluginRoot
        );
        const scratchCreate = parseJsonOutput<SfJsonResult>(scratchCreateRaw);
        expect(scratchCreate.status).to.equal(0);
        createdScratch = true;
      } catch (error) {
        if (isScratchLimitExceeded(error)) {
          this.skip();
          return;
        }
        throw error;
      }
    }

    const baselineDeployRaw = runSf(
      [
        'project',
        'deploy',
        'start',
        '--target-org',
        scratchAlias,
        '--source-dir',
        'force-app',
        '--wait',
        '30',
        '--ignore-warnings',
        '--ignore-conflicts',
        '--json',
      ],
      repoRoot
    );
    const baselineDeploy = parseJsonOutput<SfJsonResult>(baselineDeployRaw);
    expect(baselineDeploy.status).to.equal(0);

    await applyScenarioChanges(repoRoot, 'repo-basic');

    const deltaOutputDir = path.join(repoRoot, 'tmp-delta');
    const deltaRaw = runSf(
      [
        'df',
        'git',
        'delta',
        '--from',
        'HEAD',
        '--source-dir',
        'force-app/main/default',
        '--output-dir',
        deltaOutputDir,
        '--json',
      ],
      repoRoot
    );
    const deltaResult = parseJsonOutput<SfJsonResult>(deltaRaw);
    expect(deltaResult.status).to.equal(0);
    expect(deltaResult.result?.processedChanges).to.be.greaterThan(0);

    const packagePath = path.join(deltaOutputDir, 'package/force-app/main/default');
    const destructiveManifestPath = path.join(deltaOutputDir, 'destructive/destructiveChanges.xml');

    const deltaDeployArgs = [
      'project',
      'deploy',
      'start',
      '--target-org',
      scratchAlias,
      '--source-dir',
      packagePath,
      '--wait',
      '30',
      '--ignore-warnings',
      '--ignore-conflicts',
      '--json',
    ];

    const deltaDeployRaw = runSf(deltaDeployArgs, repoRoot);
    const deltaDeploy = parseJsonOutput<SfJsonResult>(deltaDeployRaw);
    expect(deltaDeploy.status).to.equal(0);
    expect(await fileExists(destructiveManifestPath)).to.equal(true);

    const deployedObject = await readFile(
      path.join(deltaOutputDir, 'package/force-app/main/default/objects/Invoice__c/Invoice__c.object-meta.xml'),
      'utf8'
    );
    const expectedObject = await readScenarioExpectedFile(
      'repo-basic',
      'force-app/main/default/objects/Invoice__c/Invoice__c.object-meta.xml'
    );
    const expectedLabels = await readScenarioExpectedFile(
      'repo-basic',
      'force-app/main/default/labels/CustomLabels.labels-meta.xml'
    );
    const generatedLabels = await readFile(
      path.join(deltaOutputDir, 'package/force-app/main/default/labels/CustomLabels.labels-meta.xml'),
      'utf8'
    );

    expect(deployedObject.trim()).to.equal(expectedObject.trim());
    expect(generatedLabels.trim()).to.equal(expectedLabels.trim());
  });
});
