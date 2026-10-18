import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { pathExists } from '../delta/fs.js';
import { CONFIG_KEY, normalizeOrgUrl, parseDeployConfig, type DeployOrgConfig } from './config.js';

export type OrgMapping = DeployOrgConfig & {
  // Aliases (or usernames) of the orgs authenticated on this machine with this URL. Never stored: they differ
  // between machines.
  localAliases: string[];
};

export type OrgMapResult = {
  action: 'list' | 'mapped' | 'unchanged' | 'removed';
  projectFile: string;
  orgs: OrgMapping[];
  // Branch the org was mapped to before --branch changed it.
  previousBranch?: string;
};

export type LocalOrg = { instanceUrl?: string; username: string; aliases?: string[] | null };

type ProjectFile = {
  path: string;
  json: Record<string, unknown>;
  indent: string;
  eol: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const readProjectFile = async (repoRoot: string): Promise<ProjectFile> => {
  const filePath = path.join(repoRoot, 'sfdx-project.json');
  if (!(await pathExists(filePath))) {
    throw new Error(`No sfdx-project.json at the root of the repository (${repoRoot}).`);
  }

  const content = await readFile(filePath, 'utf8');
  const json = JSON.parse(content) as unknown;
  if (!isRecord(json)) {
    throw new Error(`${filePath} is not a JSON object.`);
  }

  return {
    path: filePath,
    json,
    indent: /^([ \t]+)"/m.exec(content)?.[1] ?? '  ',
    eol: content.includes('\r\n') ? '\r\n' : '\n',
  };
};

// Only "plugins.sfdf.orgs" changes: the rest of the file keeps its keys, order and indentation.
const writeProjectFile = async (project: ProjectFile): Promise<void> => {
  const content = JSON.stringify(project.json, null, project.indent).replaceAll('\n', project.eol);
  await writeFile(project.path, content + project.eol, 'utf8');
};

// The mapping as declared, empty when nothing is declared yet. Invalid content still throws.
export const mappedOrgs = (project: ProjectFile): DeployOrgConfig[] => {
  const plugins = project.json.plugins;
  const settings = isRecord(plugins) ? plugins[CONFIG_KEY] : undefined;
  if (!isRecord(settings) || (Array.isArray(settings.orgs) && settings.orgs.length === 0)) {
    return [];
  }

  return parseDeployConfig(project.json, project.path).orgs;
};

const setMappedOrgs = (project: ProjectFile, orgs: DeployOrgConfig[]): void => {
  const plugins = isRecord(project.json.plugins) ? project.json.plugins : {};
  const settings = isRecord(plugins[CONFIG_KEY]) ? plugins[CONFIG_KEY] : {};
  project.json.plugins = { ...plugins, [CONFIG_KEY]: { ...settings, orgs } };
};

export const withLocalAliases = (orgs: DeployOrgConfig[], localOrgs: LocalOrg[]): OrgMapping[] =>
  orgs.map((org) => ({
    ...org,
    localAliases: localOrgs
      .filter((local) => local.instanceUrl && normalizeOrgUrl(local.instanceUrl) === normalizeOrgUrl(org.url))
      .flatMap((local) => (local.aliases?.length ? local.aliases : [local.username])),
  }));

// Maps the org to the branch: adds the entry, or changes the branch of an org already mapped. A branch belongs to one
// org only, since its tip is what that org holds.
export const mapOrg = async (
  repoRoot: string,
  orgUrl: string,
  branch: string
): Promise<Omit<OrgMapResult, 'orgs'> & { orgs: DeployOrgConfig[] }> => {
  const project = await readProjectFile(repoRoot);
  const orgs = mappedOrgs(project);
  const wanted = normalizeOrgUrl(orgUrl);
  const existing = orgs.find((org) => normalizeOrgUrl(org.url) === wanted);
  const owner = orgs.find((org) => org.branch === branch && normalizeOrgUrl(org.url) !== wanted);
  if (owner) {
    throw new Error(
      `The branch "${branch}" is already mapped to ${owner.url}: a branch holds the content of one org only. Remove that mapping first.`
    );
  }

  if (existing?.branch === branch) {
    return { action: 'unchanged', projectFile: project.path, orgs };
  }

  const updated = existing
    ? orgs.map((org) => (org === existing ? { ...org, branch } : org))
    : [...orgs, { url: orgUrl, branch }];
  setMappedOrgs(project, updated);
  await writeProjectFile(project);
  return { action: 'mapped', projectFile: project.path, orgs: updated, previousBranch: existing?.branch };
};

export const unmapOrg = async (
  repoRoot: string,
  orgUrl: string
): Promise<Omit<OrgMapResult, 'orgs'> & { orgs: DeployOrgConfig[] }> => {
  const project = await readProjectFile(repoRoot);
  const orgs = mappedOrgs(project);
  const wanted = normalizeOrgUrl(orgUrl);
  const removed = orgs.find((org) => normalizeOrgUrl(org.url) === wanted);
  if (!removed) {
    throw new Error(`The org ${orgUrl} is not mapped to any branch.`);
  }

  const kept = orgs.filter((org) => org !== removed);
  setMappedOrgs(project, kept);
  await writeProjectFile(project);
  return { action: 'removed', projectFile: project.path, orgs: kept, previousBranch: removed.branch };
};
