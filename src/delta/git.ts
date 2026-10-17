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

  return changes;
};
