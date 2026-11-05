import { SfError } from '@salesforce/core';

import { gitRoot, resolveCommit, virtualMerge } from '../deploy/git.js';

export type MergePreviewResult = {
  from: string;
  into: string;
  fromCommit: string;
  intoCommit: string;
  // The merge commit, on no branch. Equals intoCommit when `from` is already merged; empty when there are conflicts.
  commit: string;
  alreadyMerged: boolean;
  conflicts: string[];
};

export type MergePreviewOptions = {
  cwd: string;
  from: string;
  into: string;
  message?: string;
  // Command git runs for files declared "merge=deltaforce". Defaults to `sf df git merge-driver run`.
  driverCommand?: string;
};

const NAME = 'MergePreview';

const commitOf = async (cwd: string, ref: string, flag: string): Promise<string> => {
  try {
    return await resolveCommit(cwd, ref);
  } catch (error) {
    throw new SfError(`--${flag} "${ref}" is not a commit of this repository.`, NAME, [
      'Fetch it first (git fetch), then pass the remote branch: origin/<branch>.',
    ], undefined, error);
  }
};

// The merge `sf df deploy` does, on its own: `from` is merged into `into` without checkout and without moving any
// branch. The result is a commit that only exists in the object store, ready for `sf df git delta --to <commit>`.
export const previewMerge = async (options: MergePreviewOptions): Promise<MergePreviewResult> => {
  const cwd = await gitRoot(options.cwd);
  const intoCommit = await commitOf(cwd, options.into, 'into');
  const fromCommit = await commitOf(cwd, options.from, 'from');

  const merge = await virtualMerge({
    cwd,
    base: intoCommit,
    source: fromCommit,
    message: options.message ?? `Merge ${options.from} into ${options.into}`,
    driverCommand: options.driverCommand,
  });

  return {
    from: options.from,
    into: options.into,
    fromCommit,
    intoCommit,
    commit: merge.commit,
    alreadyMerged: merge.alreadyMerged,
    conflicts: merge.conflicts,
  };
};
