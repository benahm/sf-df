import path from 'node:path';

import type { Connection, PollingClient } from '@salesforce/core';
import { ComponentSet, type MetadataApiDeploy } from '@salesforce/source-deploy-retrieve';

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
  componentFailures: string[];
  testFailures: string[];
  errorMessage?: string;
};

export type Deployer = (request: DeployRequest) => Promise<DeployOutcome>;

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

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
    } catch (error) {
      // Timeout: the job keeps running in the org, its id is enough to follow it.
      return {
        id: deploy.id,
        success: false,
        status: 'Unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        componentFailures: [],
        testFailures: [],
      };
    }
  };
