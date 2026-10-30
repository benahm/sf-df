import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { GitChange, GitChangeStatus } from './types.js';

const execFileAsync = promisify(execFile);

const parseStatus = (rawStatus: string): GitChangeStatus => {
  const statusCode = rawStatus.charAt(0);
  switch (statusCode) {
    // A copy leaves its source untouched, so only the new path matters.
    case 'A':
    case 'C':
      return 'add';
    case 'D':
      return 'delete';
    case 'R':
      return 'rename';
    default:
      return 'modify';
  }
};

// Renames and copies carry two paths (source then destination); every other status carries one.
const hasTwoPaths = (rawStatus: string): boolean => rawStatus.startsWith('R') || rawStatus.startsWith('C');

// Files on disk that were never added to git, minus the ignored ones: `git diff` does not see them.
const getUntrackedFiles = async (cwd: string, pathspec = '.'): Promise<string[]> => {
  const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', pathspec], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean);
};

// Without `to`, the target is the working tree as it is on disk, like `sf project deploy start`: new files count
// whether or not they were added to git.
export const getGitChanges = async (cwd: string, from: string, to?: string): Promise<GitChange[]> => {
  // -z keeps paths verbatim (no quoting) even when they contain tabs, quotes or newlines.
  const args = ['diff', '--name-status', '-z', '-M', from];

  if (to) {
    args.push(to);
  }

  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  const tokens = stdout.split('\0');
  const changes: GitChange[] = [];

  for (let index = 0; index < tokens.length; ) {
    const rawStatus = tokens[index++];
    if (!rawStatus) {
      continue;
    }

    const firstPath = tokens[index++];
    const secondPath = hasTwoPaths(rawStatus) ? tokens[index++] : undefined;
    if (!firstPath) {
      continue;
    }

    const status = parseStatus(rawStatus);
    changes.push({
      status,
      path: secondPath ?? firstPath,
      previousPath: status === 'rename' ? firstPath : undefined,
    });
  }

  if (!to) {
    changes.push(...(await getUntrackedFiles(cwd)).map((untrackedPath): GitChange => ({ status: 'add', path: untrackedPath })));
  }

  return changes;
};

// Files of `sourceDir` that differ from HEAD on disk (staged or not, untracked included): a delta to HEAD leaves them out.
export const getUncommittedFiles = async (cwd: string, sourceDir: string): Promise<string[]> => {
  const { stdout } = await execFileAsync('git', ['diff', 'HEAD', '--name-only', '-z', '--', sourceDir], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return [...stdout.split('\0').filter(Boolean), ...(await getUntrackedFiles(cwd, sourceDir))];
};
