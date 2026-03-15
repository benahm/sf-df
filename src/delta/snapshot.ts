import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { SnapshotRef } from './types.js';

const execFileAsync = promisify(execFile);

const extractGitSnapshot = async (cwd: string, ref: string, sourceDir: string): Promise<string> => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-delta-'));
  const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '--name-only', ref, sourceDir], {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  const files = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  await Promise.all(
    files.map(async (relativePath) => {
      const { stdout: content } = await execFileAsync('git', ['show', `${ref}:${relativePath}`], {
        cwd,
        encoding: 'buffer',
        maxBuffer: 20 * 1024 * 1024,
      });
      const destination = path.join(tempRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    })
  );

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
