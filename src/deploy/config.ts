import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { pathExists } from '../delta/fs.js';

// Declared once in sfdx-project.json, under the "plugins" key Salesforce reserves for plugin settings:
// "plugins": { "sfdf": { "orgs": [{ "url": "https://example--int.sandbox.my.salesforce.com", "branch": "int" }] } }
export type DeployOrgConfig = {
  url: string;
  branch: string;
};

export type DeployConfig = {
  orgs: DeployOrgConfig[];
  remote: string;
  sourceDir: string;
};

export const CONFIG_KEY = 'sfdf';
const DEFAULT_REMOTE = 'origin';
const DEFAULT_SOURCE_DIR = 'force-app/main/default';

// The My Domain URL identifies an org for everyone (aliases differ between machines and CI) and survives a sandbox
// refresh. Protocol, case and trailing slash are not significant.
export const normalizeOrgUrl = (url: string): string =>
  url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const configError = (projectFile: string, problem: string): Error =>
  new Error(`Invalid "plugins.${CONFIG_KEY}" in ${projectFile}: ${problem}`);

export const parseDeployConfig = (project: unknown, projectFile = 'sfdx-project.json'): DeployConfig => {
  const plugins = isRecord(project) ? project.plugins : undefined;
  const settings = isRecord(plugins) ? plugins[CONFIG_KEY] : undefined;
  if (!isRecord(settings)) {
    throw configError(
      projectFile,
      'missing. Map each org to its branch with: sf df org map --target-org <org> --branch <branch>'
    );
  }

  if (!Array.isArray(settings.orgs) || settings.orgs.length === 0) {
    throw configError(projectFile, '"orgs" must list at least one { "url", "branch" }.');
  }

  const orgs = settings.orgs.map((entry, index): DeployOrgConfig => {
    if (
      !isRecord(entry) ||
      typeof entry.url !== 'string' ||
      typeof entry.branch !== 'string' ||
      !entry.url ||
      !entry.branch
    ) {
      throw configError(projectFile, `"orgs[${index}]" must have a non-empty "url" and "branch".`);
    }

    return { url: entry.url, branch: entry.branch };
  });

  const urls = orgs.map((org) => normalizeOrgUrl(org.url));
  const duplicate = urls.find((url, index) => urls.indexOf(url) !== index);
  if (duplicate) {
    throw configError(projectFile, `the org ${duplicate} is declared twice.`);
  }

  const branches = orgs.map((org) => org.branch);
  const sharedBranch = branches.find((branch, index) => branches.indexOf(branch) !== index);
  if (sharedBranch) {
    // One branch = one org: the branch tip is what is deployed in its org.
    throw configError(projectFile, `the branch "${sharedBranch}" is linked to several orgs.`);
  }

  return {
    orgs,
    remote: typeof settings.remote === 'string' && settings.remote ? settings.remote : DEFAULT_REMOTE,
    sourceDir:
      typeof settings.sourceDir === 'string' && settings.sourceDir
        ? settings.sourceDir.replaceAll('\\', '/').replace(/\/+$/, '')
        : DEFAULT_SOURCE_DIR,
  };
};

export const readDeployConfig = async (repoRoot: string): Promise<DeployConfig> => {
  const projectFile = path.join(repoRoot, 'sfdx-project.json');
  if (!(await pathExists(projectFile))) {
    throw new Error(`No sfdx-project.json at the root of the repository (${repoRoot}).`);
  }

  return parseDeployConfig(JSON.parse(await readFile(projectFile, 'utf8')) as unknown, projectFile);
};

export const findOrgConfig = (config: DeployConfig, instanceUrl: string): DeployOrgConfig | undefined => {
  const wanted = normalizeOrgUrl(instanceUrl);
  return config.orgs.find((org) => normalizeOrgUrl(org.url) === wanted);
};
