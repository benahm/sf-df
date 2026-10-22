import path from 'node:path';

import type { Connection } from '@salesforce/core';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';

import { listMetadataNames } from './metadata-read.js';
import type { ProfileSource } from './profile-retrieve.js';

// `--metadata` entry read as `sf project retrieve start` reads it: `Profile` alone means every profile, the name
// may contain colons. Undefined for another type.
export const profileNameOfEntry = (entry: string): string | undefined => {
  const [type, ...name] = entry.split(':');
  if (type.trim() !== 'Profile') {
    return undefined;
  }

  const fullName = name.join(':').trim();
  return fullName.length > 0 ? fullName : '*';
};

// Profile members of a package.xml, `*` included. The other types are ignored: a project manifest lists many.
export const profileNamesOfManifest = async (manifestPath: string): Promise<string[]> =>
  (await ComponentSet.fromManifest(manifestPath))
    .toArray()
    .filter((component) => component.type.name === 'Profile')
    .map((component) => component.fullName);

export const listOrgProfiles = async (connection: Connection): Promise<string[]> =>
  listMetadataNames(connection, 'Profile');

const escapeRegExp = (value: string): string => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// `*` matches any characters, as minimatch does for the wildcards of `sf project retrieve start`.
const wildcardToRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);

// A file keeps the encoded name (`System Admin %2B Bulk Delete Permission`): a name typed or listed decoded must
// still find it.
const comparableName = (fullName: string): string => {
  try {
    return decodeURIComponent(fullName);
  } catch {
    return fullName;
  }
};

export type SelectProfilesOptions = {
  // Names of `--metadata` or `--manifest`, with wildcards.
  names: string[];
  // Profiles of the project: a selected profile found there is overwritten in place.
  local: ProfileSource[];
  // Where a profile not in the project yet is written, as `sf project retrieve start` does.
  newProfilesDir: string;
  // Only called when a name holds a wildcard, as `sf project retrieve start` resolves wildcards against the org.
  listOrgProfiles: () => Promise<string[]>;
};

export const selectProfiles = async (options: SelectProfilesOptions): Promise<ProfileSource[]> => {
  const patterns = options.names.filter((name) => name.includes('*')).map(wildcardToRegExp);
  const exactNames = options.names.filter((name) => !name.includes('*'));
  const orgNames =
    patterns.length > 0
      ? (await options.listOrgProfiles()).filter((name) => patterns.some((pattern) => pattern.test(name)))
      : [];

  const localByName = new Map(options.local.map((source) => [comparableName(source.fullName), source]));
  const selected = new Map<string, ProfileSource>();
  for (const fullName of [...exactNames, ...orgNames]) {
    const key = comparableName(fullName);
    if (!selected.has(key)) {
      selected.set(
        key,
        localByName.get(key) ?? {
          fullName,
          filePath: path.join(options.newProfilesDir, `${fullName}.profile-meta.xml`),
        }
      );
    }
  }

  return [...selected.values()].sort((left, right) => left.fullName.localeCompare(right.fullName));
};
