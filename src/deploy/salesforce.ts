import path from 'node:path';

import type { Connection, PollingClient } from '@salesforce/core';
import { ComponentSet, type MetadataApiDeploy, type MetadataApiDeployStatus } from '@salesforce/source-deploy-retrieve';

import { pathExists } from '../delta/fs.js';
import type { TestPlan } from './tests.js';

export type Duration = PollingClient.Options['timeout'];

export type DeployRequest = {
  // Output of the delta engine: package.xml + source files, and the destructive manifest when something is deleted.
  packageDir: string;
  sourceDir: string;
  destructiveManifest?: string;
  testPlan: TestPlan;
  checkOnly: boolean;
  wait?: Duration;
};

export type DeployOutcome = {
  id?: string;
  success: boolean;
  status: string;
  // The job was not seen finishing (wait elapsed, connection lost): it may still succeed in the org.
  pending?: boolean;
  componentFailures: string[];
  testFailures: string[];
  errorMessage?: string;
};

export type Deployer = (request: DeployRequest) => Promise<DeployOutcome>;

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const toOutcome = (response: MetadataApiDeployStatus): DeployOutcome => {
  const details = response.details ?? {};
  return {
    id: response.id,
    success: response.success,
    status: String(response.status),
    errorMessage: response.errorMessage,
    componentFailures: asArray(details.componentFailures).map((failure) =>
      `${failure.componentType ?? ''}:${failure.fullName} ${failure.problem ?? ''}`.trim()
    ),
    testFailures: asArray(details.runTestResult?.failures).map((failure) =>
      `${failure.name}.${failure.methodName} ${failure.message}`.trim()
    ),
  };
};

// One Metadata API job holds the package and the post-destructive changes: the deployment is atomic, a single
// rejected component rolls everything back.
export const metadataApiDeployer =
  (connection: Connection): Deployer =>
  async (request) => {
    const resolveSourcePath = path.join(request.packageDir, request.sourceDir);
    const componentSet = await ComponentSet.fromManifest({
      manifestPath: path.join(request.packageDir, 'package.xml'),
      resolveSourcePaths: (await pathExists(resolveSourcePath)) ? [resolveSourcePath] : [],
      destructivePost: request.destructiveManifest,
    });

    const deploy: MetadataApiDeploy = await componentSet.deploy({
      usernameOrConnection: connection,
      apiOptions: {
        checkOnly: request.checkOnly,
        rollbackOnError: true,
        testLevel: request.testPlan.testLevel,
        ...(request.testPlan.tests.length > 0 ? { runTests: request.testPlan.tests } : {}),
      },
    });

    try {
      const { response } = await deploy.pollStatus({ timeout: request.wait });
      return toOutcome(response);
    } catch (error) {
      // The wait elapsed or polling broke, which says nothing about the job: ask the org once more.
      const pending: DeployOutcome = {
        id: deploy.id,
        success: false,
        pending: true,
        status: 'Unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        componentFailures: [],
        testFailures: [],
      };
      try {
        const response = await deploy.checkStatus();
        return response.done ? toOutcome(response) : { ...pending, status: String(response.status) };
      } catch {
        return pending;
      }
    }
  };
