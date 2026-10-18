import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { mergeMetadataXml } from './xml-merge.js';

const execFileAsync = promisify(execFile);

// git calls the driver with temporary files: %O (ancestor), %A (current, receives the result), %B (other).
export type MergeDriverOptions = {
  ancestor: string;
  current: string;
  other: string;
  markerSize?: number;
  path?: string;
};

export type MergeDriverResult = {
  path?: string;
  // "xml" when merged by key, "text" when the file couldn't be and git's line merge was used.
  strategy: 'xml' | 'text';
  conflicts: number;
};

const LABELS = { ours: 'ours', theirs: 'theirs' };

// Same result as git's default merge: conflict markers in the current file, exit code = number of conflicts.
const lineMerge = async ({ ancestor, current, other, markerSize = 7 }: MergeDriverOptions): Promise<number> => {
  try {
    await execFileAsync('git', [
      'merge-file',
      `--marker-size=${markerSize}`,
      '-L',
      LABELS.ours,
      '-L',
      'base',
      '-L',
      LABELS.theirs,
      current,
      ancestor,
      other,
    ]);
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number' && code > 0 && code < 128) {
      return code;
    }

    throw error;
  }
};

export const runMergeDriver = async (options: MergeDriverOptions): Promise<MergeDriverResult> => {
  const [base, ours, theirs] = await Promise.all(
    [options.ancestor, options.current, options.other].map((file) => readFile(file, 'utf8'))
  );
  const merged = mergeMetadataXml(base, ours, theirs, { markerSize: options.markerSize, labels: LABELS });

  if (!merged) {
    return { path: options.path, strategy: 'text', conflicts: await lineMerge(options) };
  }

  if (merged.content !== ours) {
    await writeFile(options.current, merged.content, 'utf8');
  }

  return { path: options.path, strategy: 'xml', conflicts: merged.conflicts };
};
