import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Connection } from '@salesforce/core';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';

import { formatMetadataFile, readMetadataRaw, type ReadMetadataOptions } from './metadata-read.js';

export type ProfileRetrieveStatus = 'retrieved' | 'notFound' | 'failed';

export type RetrievedProfile = {
  fullName: string;
  filePath: string;
  status: ProfileRetrieveStatus;
  error?: string;
};

export type ProfileRetrieveResult = {
  profiles: RetrievedProfile[];
};

export type ProfileRetrieveOptions = ReadMetadataOptions & {
  connection: Connection;
  sourcePath: string;
  // Profiles already found in sourcePath, so that the source is not resolved twice.
  sources?: ProfileSource[];
  outputDir?: string;
  concurrency?: number;
  onProgress?: (profile: RetrievedProfile, done: number, total: number) => void;
};

// One profile per call: the org serves a readMetadata call holding several profiles one after the other, while
// parallel calls are served together (6 profiles: 67 s in one call, 27 s in 6 parallel calls on a 600-profile
// sandbox). Each call holds a single profile in memory, written as soon as it arrives.
const DEFAULT_CONCURRENCY = 5;

export type ProfileSource = { fullName: string; filePath: string };

// Profiles of a source file or folder, named as the org names them. SDR keeps the encoded file name
// (`System Admin %2B Bulk Delete Permission`), which is also the API full name, and ignores files that are not
// profiles.
export const findProfileSources = (sourcePath: string): ProfileSource[] =>
  ComponentSet.fromSource(sourcePath)
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
    ? path.join(options.outputDir, path.basename(source.filePath))
    : source.filePath;
  try {
    const [record] = await readMetadataRaw(options.connection, 'Profile', [source.fullName], options);
    if (!record) {
      // The local file is left untouched: an empty profile would remove every access on the next deployment.
      return { fullName: source.fullName, filePath: source.filePath, status: 'notFound' };
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, formatMetadataFile('Profile', record.body));
    return { fullName: source.fullName, filePath, status: 'retrieved' };
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
  const sources = options.sources ?? findProfileSources(options.sourcePath);
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
