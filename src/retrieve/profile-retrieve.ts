import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Connection } from '@salesforce/core';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';

import { formatMetadataFile, readMetadataRaw, type ReadMetadataOptions } from './metadata-read.js';
import { makeDeployable, type LeftOutEntry } from './profile-deployable.js';
import { filterProfile, type ProfileFilterOptions } from './profile-filter.js';

export type ProfileRetrieveStatus = 'retrieved' | 'notFound' | 'failed';

export type RetrievedProfile = {
  fullName: string;
  filePath: string;
  status: ProfileRetrieveStatus;
  error?: string;
  // Entries the org returned but refuses to deploy, left out of the file.
  leftOut?: LeftOutEntry[];
};

export type ProfileRetrieveResult = {
  profiles: RetrievedProfile[];
};

export type ProfileRetrieveOptions = ReadMetadataOptions & {
  connection: Connection;
  // Profiles to retrieve. When omitted, every profile found in sourcePath.
  sources?: ProfileSource[];
  sourcePath?: string | string[];
  // Profiles are written to <outputDir>/profiles, where `sf project retrieve start --output-dir` writes them.
  outputDir?: string;
  // Entries kept from the complete profile. When omitted, every entry the org returns.
  filter?: ProfileFilterOptions;
  // Standard tabs of the org: settings for the other standard tabs are left out. Undefined: they are kept.
  standardTabs?: Set<string>;
  concurrency?: number;
  onProgress?: (profile: RetrievedProfile, done: number, total: number) => void;
};

// One profile per call: the org serves a readMetadata call holding several profiles one after the other, while
// parallel calls are served together (6 profiles: 67 s in one call, 27 s in 6 parallel calls on a 600-profile
// sandbox). Each call holds a single profile in memory, written as soon as it arrives.
const DEFAULT_CONCURRENCY = 5;

export type ProfileSource = { fullName: string; filePath: string };

// Profiles of source files or folders, named as the org names them. SDR keeps the encoded file name
// (`System Admin %2B Bulk Delete Permission`), which is also the API full name, and ignores files that are not
// profiles.
export const findProfileSources = (sourcePath: string | string[]): ProfileSource[] =>
  ComponentSet.fromSource({ fsPaths: Array.isArray(sourcePath) ? sourcePath : [sourcePath] })
    .getSourceComponents()
    .toArray()
    .filter((component) => component.type.name === 'Profile' && component.xml)
    .map((component) => ({ fullName: component.fullName, filePath: component.xml! }))
    .sort((left, right) => left.fullName.localeCompare(right.fullName));

// Written next to the target then renamed: an interrupted command never leaves a truncated profile.
const writeFileAtomic = async (filePath: string, content: string): Promise<void> => {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
};

const retrieveOne = async (source: ProfileSource, options: ProfileRetrieveOptions): Promise<RetrievedProfile> => {
  const filePath = options.outputDir
    ? path.join(options.outputDir, 'profiles', path.basename(source.filePath))
    : source.filePath;
  try {
    const [record] = await readMetadataRaw(options.connection, 'Profile', [source.fullName], options);
    if (!record) {
      // The local file is left untouched: an empty profile would remove every access on the next deployment.
      return { fullName: source.fullName, filePath: source.filePath, status: 'notFound' };
    }

    const deployable = makeDeployable(formatMetadataFile('Profile', record.body), {
      standardTabs: options.standardTabs,
    });
    let content = deployable.xml;
    if (options.filter) {
      // The project's file, even with --output-dir: its entries are the ones the project already tracks.
      const localXml = await readFile(source.filePath, 'utf8').catch(() => undefined);
      content = filterProfile(content, options.filter, localXml);
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, content);
    return {
      fullName: source.fullName,
      filePath,
      status: 'retrieved',
      ...(deployable.leftOut.length > 0 ? { leftOut: deployable.leftOut } : {}),
    };
  } catch (error) {
    return {
      fullName: source.fullName,
      filePath: source.filePath,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const retrieveProfiles = async (options: ProfileRetrieveOptions): Promise<ProfileRetrieveResult> => {
  const sources = options.sources ?? findProfileSources(options.sourcePath ?? []);
  const profiles: RetrievedProfile[] = [];
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (next < sources.length) {
      const index = next++;
      // eslint-disable-next-line no-await-in-loop
      profiles[index] = await retrieveOne(sources[index], options);
      done += 1;
      options.onProgress?.(profiles[index], done, sources.length);
    }
  };

  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, sources.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { profiles };
};
