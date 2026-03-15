import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { GitChange, GitChangeStatus } from './types.js';

const execFileAsync = promisify(execFile);

const parseStatus = (rawStatus: string): GitChangeStatus => {
  const statusCode = rawStatus.charAt(0);
  switch (statusCode) {
    case 'A':
      return 'add';
    case 'D':
      return 'delete';
    case 'R':
      return 'rename';
    default:
      return 'modify';
  }
};

export const getGitChanges = async (cwd: string, from: string, to?: string): Promise<GitChange[]> => {
  const args = ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', from];

  if (to) {
    args.push(to);
  }

  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .flatMap((parts): GitChange[] => {
      const [rawStatus, firstPath, secondPath] = parts;
      if (!rawStatus || !firstPath) {
        return [];
      }

      const status = parseStatus(rawStatus);
      return [
        {
          status,
          path: status === 'rename' ? secondPath ?? firstPath : firstPath,
          previousPath: status === 'rename' ? firstPath : undefined,
        },
      ];
    });
};
