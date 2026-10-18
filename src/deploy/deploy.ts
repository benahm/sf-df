import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SfError } from '@salesforce/core';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';

import { generateDelta } from '../delta/engine.js';
import { pathExists } from '../delta/fs.js';
import { findOrgConfig, type DeployConfig } from './config.js';
import {
  fetchBranch,
  fetchSource,
  listFiles,
  pushCommit,
  resolveCommit,
  virtualMerge,
  type VirtualMerge,
} from './git.js';
import type { Deployer, DeployOutcome, Duration } from './salesforce.js';
import { apexClassName, planTests, type TestLevel, type TestPlan } from './tests.js';

export type DeployStatus = 'dryRun' | 'validated' | 'deployed' | 'nothingToDeploy';

export type DeployBranchResult = {
  status: DeployStatus;
  orgUrl: string;
  branch: string;
  source: string;
  // Tip of the org's branch before the run: what is deployed in the org.
  base: string;
  // Start of the delta: `base`, or --from.
  from: string;
  // Merge of the source into the branch. Pushed to the branch only after a successful deployment.
  commit: string;
  alreadyMerged: boolean;
  pushed: boolean;
  components: string[];
  deletions: string[];
  testLevel: TestLevel;
  tests: string[];
  deployId?: string;
  warnings: string[];
};

export type DeployBranchOptions = {
  repoRoot: string;
  config: DeployConfig;
  orgUrl: string;
  source: string;
  from?: string;
  dryRun?: boolean;
  validate?: boolean;
  allowDestructive?: boolean;
  testLevel?: TestLevel;
  wait?: Duration;
  deployer: Deployer;
  // Merge driver command, for tests. Defaults to `sf df git merge-driver run`.
  driverCommand?: string;
  progress?: (step: string) => void;
};

const NAME = 'DeployError';

// `Type:fullName` of every member of a package.xml or destructiveChanges.xml.
const manifestMembers = async (manifestPath: string | undefined): Promise<string[]> => {
  if (!manifestPath || !(await pathExists(manifestPath))) {
    return [];
  }

  const componentSet = await ComponentSet.fromManifest({ manifestPath, forceAddWildcards: true });
  return componentSet
    .toArray()
    .map((component) => `${component.type.name}:${component.fullName}`)
    .sort();
};

const describeFailure = (outcome: DeployOutcome): string =>
  [
    outcome.errorMessage,
    ...outcome.componentFailures.map((failure) => `  ${failure}`),
    ...outcome.testFailures.map((failure) => `  Test ${failure}`),
  ]
    .filter(Boolean)
    .join('\n');

const planTestsOf = async (
  repoRoot: string,
  commit: string,
  sourceDir: string,
  components: string[],
  requested?: TestLevel
): Promise<TestPlan> => {
  const deployedClasses = components.filter((entry) => entry.startsWith('ApexClass:')).map((entry) => entry.slice(10));
  const existingClasses = (await listFiles(repoRoot, commit, sourceDir))
    .map(apexClassName)
    .filter((name): name is string => name !== undefined);
  return planTests(deployedClasses, existingClasses, requested);
};

const branchOf = (config: DeployConfig, orgUrl: string): string => {
  const orgConfig = findOrgConfig(config, orgUrl);
  if (!orgConfig) {
    throw new SfError(
      `The org ${orgUrl} is not declared in sfdx-project.json ("plugins.sfdf.orgs"): its branch is unknown.`,
      NAME,
      ['Map it: sf df org map --target-org <org> --branch <branch>, then commit sfdx-project.json.']
    );
  }

  return orgConfig.branch;
};

// Fetches the org's branch and the source, then merges them without checkout.
const mergeSource = async (
  options: DeployBranchOptions,
  branch: string,
  progress: (step: string) => void
): Promise<{ base: string; merge: VirtualMerge }> => {
  const { repoRoot } = options;
  const { remote } = options.config;

  progress(`Fetching ${remote}/${branch} and ${options.source}`);
  let base: string;
  try {
    base = await fetchBranch(repoRoot, remote, branch);
  } catch (error) {
    throw new SfError(`The branch "${branch}" of the org can't be fetched from ${remote}.`, NAME, [], undefined, error);
  }

  const source = await fetchSource(repoRoot, remote, options.source);

  progress(`Merging ${options.source} into ${branch}`);
  const merge = await virtualMerge({
    cwd: repoRoot,
    base,
    source,
    message: `Merge ${options.source} into ${branch}\n\nDeployed by sf df deploy.`,
    driverCommand: options.driverCommand,
  });
  if (merge.conflicts.length > 0) {
    throw new SfError(
      `${options.source} conflicts with ${branch}. Nothing was deployed.\n${merge.conflicts
        .map((file) => `  ${file}`)
        .join('\n')}`,
      NAME,
      [`Merge ${branch} into ${options.source}, resolve the conflicts, push, then run the command again.`]
    );
  }

  return { base, merge };
};

const checkDeletions = (deletions: string[], options: DeployBranchOptions): void => {
  if (deletions.length > 0 && !options.allowDestructive && !options.validate) {
    throw new SfError(
      `The delta deletes ${deletions.length} component(s) from the org. Nothing was deployed.\n${deletions
        .map((entry) => `  ${entry}`)
        .join('\n')}`,
      NAME,
      ['Check the list, then run the command again with --allow-destructive.']
    );
  }
};

// Called once the org holds the merge: the branch catches up, fast-forward only.
const pushDeployedMerge = async (
  options: DeployBranchOptions,
  branch: string,
  commit: string,
  deployId?: string
): Promise<void> => {
  const { remote } = options.config;
  try {
    await pushCommit(options.repoRoot, remote, commit, branch);
  } catch (error) {
    throw new SfError(
      `Deployed (job ${
        deployId ?? 'unknown'
      }), but the merge couldn't be pushed to ${remote}/${branch}: the org is ahead of its branch.`,
      NAME,
      [
        `Run the command again for ${options.source}: it is redeployed (already in the org, harmless) and pushed.`,
        `Only sf df deploy should push to ${branch}: protect the branch in the forge.`,
      ],
      undefined,
      error
    );
  }
};

// Merges the source into the org's branch without checkout, deploys the delta between what the org holds (the
// branch tip) and the merge, and pushes the merge to the branch only when the deployment succeeded: the branch
// always describes the org.
export const deployBranch = async (options: DeployBranchOptions): Promise<DeployBranchResult> => {
  const { repoRoot, config, progress = (): void => {} } = options;
  const { remote, sourceDir } = config;
  const branch = branchOf(config, options.orgUrl);
  const { base, merge } = await mergeSource(options, branch, progress);
  const from = options.from ? await resolveCommit(repoRoot, options.from) : base;
  const workDir = await mkdtemp(path.join(tmpdir(), 'sf-df-deploy-'));

  try {
    progress(`Computing the delta ${from.slice(0, 7)}..${merge.commit.slice(0, 7)}`);
    const delta = await generateDelta({
      repoRoot,
      from,
      to: merge.commit,
      sourceDir,
      deployDir: path.join(workDir, 'package'),
      destructiveDir: path.join(workDir, 'destructive'),
    });
    const destructiveManifest = (await pathExists(delta.destructiveManifestPath!))
      ? delta.destructiveManifestPath
      : undefined;
    const [components, deletions] = await Promise.all([
      manifestMembers(delta.packageManifestPath),
      manifestMembers(destructiveManifest),
    ]);
    const nothingToDeploy = components.length === 0 && deletions.length === 0;
    const plan: TestPlan = nothingToDeploy
      ? { testLevel: 'NoTestRun', tests: [] }
      : await planTestsOf(repoRoot, merge.commit, sourceDir, components, options.testLevel);

    const result: DeployBranchResult = {
      status: 'nothingToDeploy',
      orgUrl: options.orgUrl,
      branch,
      source: options.source,
      base,
      from,
      commit: merge.commit,
      alreadyMerged: merge.alreadyMerged,
      pushed: false,
      components,
      deletions,
      testLevel: plan.testLevel,
      tests: plan.tests,
      warnings: [...delta.warnings],
    };

    if (options.dryRun) {
      return { ...result, status: 'dryRun' };
    }

    if (nothingToDeploy) {
      // The merge only touches files outside the metadata (README, CI...): it still goes to the branch.
      if (!options.validate && merge.commit !== base) {
        progress(`Pushing the merge to ${remote}/${branch}`);
        await pushCommit(repoRoot, remote, merge.commit, branch);
        result.pushed = true;
      }

      return result;
    }

    checkDeletions(deletions, options);

    progress(options.validate ? 'Validating the deployment (check only)' : 'Deploying');
    const outcome = await options.deployer({
      packageDir: delta.packageDir,
      sourceDir,
      destructiveManifest,
      testPlan: plan,
      checkOnly: options.validate ?? false,
      wait: options.wait,
    });
    result.deployId = outcome.id;

    if (!outcome.success) {
      const job = outcome.id ? ` (job ${outcome.id})` : '';
      throw new SfError(
        `The deployment failed${job}. Nothing was pushed: ${branch} still matches the org.\n${describeFailure(
          outcome
        )}`,
        NAME
      );
    }

    if (options.validate) {
      return { ...result, status: 'validated' };
    }

    if (merge.commit !== base) {
      progress(`Pushing the merge to ${remote}/${branch}`);
      await pushDeployedMerge(options, branch, merge.commit, outcome.id);
      result.pushed = true;
    }

    return { ...result, status: 'deployed' };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};
