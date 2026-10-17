import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ComponentSet } from '@salesforce/source-deploy-retrieve';

import type { ManifestEntry } from './types.js';

// SDR validates type names against the metadata registry and writes the manifest the same way `sf` does.
export const buildManifestXml = async (entries: ManifestEntry[], apiVersion?: string): Promise<string> => {
  const componentSet = new ComponentSet();
  for (const entry of entries) {
    componentSet.add({ fullName: entry.fullName, type: entry.type });
  }

  if (apiVersion) {
    componentSet.sourceApiVersion = apiVersion;
  }

  return componentSet.getPackageXml();
};

// Without sourceApiVersion in sfdx-project.json, SDR falls back to the API version it ships with.
export const readSourceApiVersion = async (repoRoot: string): Promise<string | undefined> => {
  try {
    const project = JSON.parse(await readFile(path.join(repoRoot, 'sfdx-project.json'), 'utf8')) as {
      sourceApiVersion?: string;
    };
    return project.sourceApiVersion;
  } catch {
    return undefined;
  }
};
