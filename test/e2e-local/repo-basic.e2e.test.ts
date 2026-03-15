import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import { generateDelta } from '../../src/delta/engine.js';

const runGit = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

const createRepoFromFixture = async (scenarioName: string): Promise<string> => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-e2e-'));
  const fixtureRoot = path.resolve('test/fixtures/scenarios', scenarioName, 'baseline');

  await cp(fixtureRoot, repoRoot, { recursive: true });
  runGit(repoRoot, ['init']);
  runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
  runGit(repoRoot, ['config', 'user.email', 'e2e@example.com']);
  runGit(repoRoot, ['config', 'user.name', 'E2E Tests']);
  runGit(repoRoot, ['add', '.']);
  runGit(repoRoot, ['commit', '-m', 'base']);

  return repoRoot;
};

const applyScenarioChanges = async (repoRoot: string, scenarioName: string): Promise<void> => {
  const changedRoot = path.resolve('test/fixtures/scenarios', scenarioName, 'changed');
  await cp(changedRoot, repoRoot, { recursive: true });
};

const readScenarioExpectedFile = async (scenarioName: string, relativePath: string): Promise<string> =>
  readFile(path.resolve('test/fixtures/scenarios', scenarioName, 'expected', relativePath), 'utf8');

describe('e2e metadata deltas', () => {
  let repoRoot: string | undefined;

  afterEach(async () => {
    if (repoRoot) {
      try {
        await rm(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Temp cleanup is best-effort on Windows where file handles can be briefly locked.
      }
      repoRoot = undefined;
    }
  });

  it('builds a partial Profile delta and keeps required singleton fields', async () => {
    repoRoot = await createRepoFromFixture('repo-basic');
    await applyScenarioChanges(repoRoot, 'repo-basic');

    const outputDir = path.join(repoRoot, 'tmp-output');
    const result = await generateDelta({
      repoRoot,
      from: 'HEAD',
      sourceDir: 'force-app/main/default',
      outputDir,
    });

    const profileDelta = await readFile(
      path.join(outputDir, 'package/force-app/main/default/profiles/Admin.profile-meta.xml'),
      'utf8'
    );
    const packageXml = await readFile(result.packageManifestPath, 'utf8');

    expect(profileDelta).to.contain('<custom>false</custom>');
    expect(profileDelta).to.contain('<userLicense>Salesforce</userLicense>');
    expect(profileDelta).to.contain('<allowCreate>true</allowCreate>');
    expect(packageXml).to.contain('<name>Profile</name>');
    expect(packageXml).to.contain('<members>Admin</members>');
  });

  it('builds package and destructive deltas for CustomLabels', async () => {
    repoRoot = await createRepoFromFixture('repo-basic');
    await applyScenarioChanges(repoRoot, 'repo-basic');

    const outputDir = path.join(repoRoot, 'tmp-output');
    const result = await generateDelta({
      repoRoot,
      from: 'HEAD',
      sourceDir: 'force-app/main/default',
      outputDir,
    });

    const labelsPackageDelta = await readFile(
      path.join(outputDir, 'package/force-app/main/default/labels/CustomLabels.labels-meta.xml'),
      'utf8'
    );
    const labelsDestructiveDelta = await readFile(
      path.join(outputDir, 'destructive/force-app/main/default/labels/CustomLabels.labels-meta.xml'),
      'utf8'
    );
    const destructiveXml = await readFile(result.destructiveManifestPath!, 'utf8');
    const expectedLabels = await readScenarioExpectedFile(
      'repo-basic',
      'force-app/main/default/labels/CustomLabels.labels-meta.xml'
    );

    expect(labelsPackageDelta).to.contain('<fullName>LabelTwo</fullName>');
    expect(labelsPackageDelta).to.contain('<fullName>LabelThree</fullName>');
    expect(labelsPackageDelta).not.to.contain('<fullName>LabelOne</fullName>');
    expect(labelsPackageDelta.trim()).to.equal(expectedLabels.trim());
    expect(labelsDestructiveDelta).to.contain('<fullName>LabelOne</fullName>');
    expect(destructiveXml).to.contain('<name>CustomLabels</name>');
  });

  it('copies changed CustomObject metadata into package output', async () => {
    repoRoot = await createRepoFromFixture('repo-basic');
    await applyScenarioChanges(repoRoot, 'repo-basic');

    const outputDir = path.join(repoRoot, 'tmp-output');
    const result = await generateDelta({
      repoRoot,
      from: 'HEAD',
      sourceDir: 'force-app/main/default',
      outputDir,
    });

    const copiedObject = await readFile(
      path.join(outputDir, 'package/force-app/main/default/objects/Invoice__c/Invoice__c.object-meta.xml'),
      'utf8'
    );
    const packageXml = await readFile(result.packageManifestPath, 'utf8');
    const expectedObject = await readScenarioExpectedFile(
      'repo-basic',
      'force-app/main/default/objects/Invoice__c/Invoice__c.object-meta.xml'
    );

    expect(copiedObject.trim()).to.equal(expectedObject.trim());
    expect(packageXml).to.contain('<name>CustomObject</name>');
    expect(packageXml).to.contain('<members>Invoice__c</members>');
  });
});
