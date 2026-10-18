import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DRIVER_COMMAND, DRIVER_NAME } from '../merge/install.js';

const execFileAsync = promisify(execFile);

const run = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> =>
  (await execFileAsync('git', args, { cwd, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();

const succeeds = async (cwd: string, args: string[]): Promise<boolean> => {
  try {
    await run(cwd, args);
    return true;
  } catch {
    return false;
  }
};

export const gitRoot = async (cwd: string): Promise<string> => run(cwd, ['rev-parse', '--show-toplevel']);

export const resolveCommit = async (cwd: string, ref: string): Promise<string> =>
  run(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);

export const remoteBranchRef = (remote: string, branch: string): string => `refs/remotes/${remote}/${branch}`;

// Reads the remote branch, never the local copy: nothing is checked out, the working tree is left alone.
export const fetchBranch = async (cwd: string, remote: string, branch: string): Promise<string> => {
  await run(cwd, ['fetch', '--no-tags', remote, `+refs/heads/${branch}:${remoteBranchRef(remote, branch)}`]);
  return resolveCommit(cwd, remoteBranchRef(remote, branch));
};

// The source is a branch of the remote, as in CI. Any other ref (sha, local branch, refs/pull/...) is used as is.
export const fetchSource = async (cwd: string, remote: string, source: string): Promise<string> => {
  try {
    return await fetchBranch(cwd, remote, source);
  } catch {
    try {
      return await resolveCommit(cwd, source);
    } catch {
      throw new Error(`"${source}" is neither a branch of ${remote} nor a commit of this repository.`);
    }
  }
};

export const isAncestor = async (cwd: string, ancestor: string, descendant: string): Promise<boolean> =>
  succeeds(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);

export type VirtualMerge = {
  // Commit holding the merge result, on no branch. Equals `base` when the source is already merged.
  commit: string;
  alreadyMerged: boolean;
  conflicts: string[];
};

export type VirtualMergeOptions = {
  cwd: string;
  base: string;
  source: string;
  message: string;
  // Command git runs for files declared "merge=deltaforce". Defaults to `sf df git merge-driver run`.
  driverCommand?: string;
};

// A CI runner has no git identity: the merge commit then gets a neutral one.
const commitEnv = async (cwd: string): Promise<NodeJS.ProcessEnv> => {
  if (await succeeds(cwd, ['var', 'GIT_COMMITTER_IDENT'])) {
    return process.env;
  }

  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'sf df deploy',
    GIT_AUTHOR_EMAIL: 'sf-df@localhost',
    GIT_COMMITTER_NAME: 'sf df deploy',
    GIT_COMMITTER_EMAIL: 'sf-df@localhost',
  };
};

// Merges without checkout: `git merge-tree` writes the merged tree in the object store, `git commit-tree` wraps it in a
// merge commit that no branch points to yet. The XML merge driver is passed on the command line, so the CI needs no
// `merge-driver install`, and .gitattributes is read from the base branch (git >= 2.40).
export const virtualMerge = async (options: VirtualMergeOptions): Promise<VirtualMerge> => {
  const { cwd, base, source } = options;
  if (await isAncestor(cwd, source, base)) {
    return { commit: base, alreadyMerged: true, conflicts: [] };
  }

  const args = [
    `--attr-source=${base}`,
    '-c',
    `merge.${DRIVER_NAME}.name=Salesforce metadata merged by key (sf-df)`,
    '-c',
    `merge.${DRIVER_NAME}.driver=${options.driverCommand ?? DRIVER_COMMAND}`,
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--no-messages',
    '-z',
    base,
    source,
  ];

  let output: string;
  try {
    output = await run(cwd, args);
  } catch (error) {
    // Exit code 1 means conflicts: stdout still holds the tree, then the conflicted files.
    const { code, stdout } = error as { code?: unknown; stdout?: string };
    if (code !== 1 || !stdout) {
      throw error;
    }

    // -z keeps paths verbatim: the tree, then one NUL-terminated path per conflicted file.
    const [, ...files] = stdout.split('\0');
    return {
      commit: '',
      alreadyMerged: false,
      conflicts: [...new Set(files.filter((file) => file !== ''))],
    };
  }

  const [tree] = output.split('\0');
  const commit = await run(
    cwd,
    ['commit-tree', tree, '-p', base, '-p', source, '-m', options.message],
    await commitEnv(cwd)
  );
  return { commit, alreadyMerged: false, conflicts: [] };
};

// Fast-forward only: refused when the branch moved since it was fetched.
export const pushCommit = async (cwd: string, remote: string, commit: string, branch: string): Promise<void> => {
  await run(cwd, ['push', '--porcelain', remote, `${commit}:refs/heads/${branch}`]);
};

export const listFiles = async (cwd: string, commit: string, directory: string): Promise<string[]> => {
  const output = await run(cwd, ['ls-tree', '-r', '--name-only', commit, '--', directory]);
  return output === '' ? [] : output.split('\n');
};
