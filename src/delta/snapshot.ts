import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { SnapshotRef } from './types.js';

const execFileAsync = promisify(execFile);

const treeExists = async (cwd: string, ref: string, sourceDir: string): Promise<boolean> => {
  try {
    await execFileAsync('git', ['cat-file', '-e', `${ref}:${sourceDir}`], { cwd });
    return true;
  } catch {
    return false;
  }
};

// Loads only sourceDir into a throwaway index, then checks it out in a single git process,
// instead of spawning one `git show` per file.
const extractGitSnapshot = async (cwd: string, ref: string, sourceDir: string): Promise<string> => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-delta-'));

  // sourceDir may not exist yet at `ref` (first commit of a project): the snapshot is then empty.
  if (!(await treeExists(cwd, ref, sourceDir))) {
    return tempRoot;
  }

  const env = { ...process.env, GIT_INDEX_FILE: path.join(tempRoot, '.sf-df-index') };
  const prefix = `${tempRoot.replaceAll(path.sep, '/')}/`;
  await execFileAsync('git', ['read-tree', `--prefix=${sourceDir}/`, `${ref}:${sourceDir}`], { cwd, env });
  await execFileAsync('git', ['checkout-index', '--all', `--prefix=${prefix}`], { cwd, env });
  await rm(env.GIT_INDEX_FILE, { force: true });

  return tempRoot;
};

export class SnapshotManager {
  private readonly cleanupDirs = new Set<string>();

  public constructor(private readonly repoRoot: string, private readonly sourceDir: string) {}

  public async createFrom(ref: string): Promise<SnapshotRef> {
    const rootDir = await extractGitSnapshot(this.repoRoot, ref, this.sourceDir);
    this.cleanupDirs.add(rootDir);
    return {
      kind: 'git',
      ref,
      rootDir,
      sourceDir: this.sourceDir,
      sourceDirAbs: path.join(rootDir, this.sourceDir),
    };
  }

  public createWorkspace(): SnapshotRef {
    return {
      kind: 'workspace',
      rootDir: this.repoRoot,
      sourceDir: this.sourceDir,
      sourceDirAbs: path.join(this.repoRoot, this.sourceDir),
    };
  }

  public async cleanup(): Promise<void> {
    await Promise.all([...this.cleanupDirs].map(async (directory) => rm(directory, { recursive: true, force: true })));
  }
}
