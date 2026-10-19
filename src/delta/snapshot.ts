import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { registry } from '@salesforce/source-deploy-retrieve';

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

// SDR reads .forceignore from the project root, so the snapshot gets the one from the same ref.
const copyForceIgnore = async (cwd: string, ref: string, tempRoot: string): Promise<void> => {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:.forceignore`], { cwd, encoding: 'buffer' });
    await writeFile(path.join(tempRoot, '.forceignore'), stdout);
  } catch {
    // No .forceignore at this ref.
  }
};

const checkoutIndex = async (cwd: string, tempRoot: string, env: NodeJS.ProcessEnv): Promise<void> => {
  const prefix = `${tempRoot.replaceAll(path.sep, '/')}/`;
  await execFileAsync('git', ['-c', 'core.longpaths=true', 'checkout-index', '--all', `--prefix=${prefix}`], { cwd, env });
  await rm(env.GIT_INDEX_FILE!, { force: true });
};

// Loads only sourceDir into a throwaway index, then checks it out in a single git process,
// instead of spawning one `git show` per file.
const extractSourceDir = async (cwd: string, ref: string, sourceDir: string, tempRoot: string): Promise<void> => {
  // sourceDir may not exist yet at `ref` (first commit of a project): the snapshot is then empty.
  if (!(await treeExists(cwd, ref, sourceDir))) {
    return;
  }

  const env = { ...process.env, GIT_INDEX_FILE: path.join(tempRoot, '.sf-df-index') };
  await execFileAsync('git', ['-c', 'core.longpaths=true', 'read-tree', `--prefix=${sourceDir}/`, `${ref}:${sourceDir}`], { cwd, env });
  await checkoutIndex(cwd, tempRoot, env);
};

// Folders of the metadata registry (classes, objects, lwc...): every component lives in or right under one.
const TYPE_DIRECTORIES = new Set(
  Object.values(registry.types).flatMap((type) => (type.directoryName ? [type.directoryName] : []))
);

export type ComponentScope = { typeDir: string; key: string };

// The part of the tree a changed file needs to be resolved and deployed: its whole component folder
// (objects/Account, lwc/myCmp, reports/MyFolder) or, for a file right in a type folder, every file sharing its name
// (MyClass.cls and MyClass.cls-meta.xml). Two files belong to the same scope when their keys are equal. Undefined
// when no type folder is found: the caller then extracts the whole sourceDir.
export const componentScope = (sourceDir: string, filePath: string): ComponentScope | undefined => {
  if (!filePath.startsWith(`${sourceDir}/`)) {
    return undefined;
  }

  const segments = filePath.slice(sourceDir.length + 1).split('/');
  const typeIndex = segments.findIndex((segment, index) => index < segments.length - 1 && TYPE_DIRECTORIES.has(segment));
  if (typeIndex < 0) {
    return undefined;
  }

  const typeDir = [sourceDir, ...segments.slice(0, typeIndex + 1)].join('/');
  return { typeDir, key: `${typeDir}/${segments[typeIndex + 1].split('.')[0]}` };
};

const runWithInput = async (cwd: string, args: string[], env: NodeJS.ProcessEnv, input: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} failed: ${stderr}`))));
    child.stdin.end(input);
  });

// Extracts only the components of the changed files: on a big project, checking out the whole sourceDir takes
// minutes on Windows while a delta touches a handful of folders.
const extractScopes = async (
  cwd: string,
  ref: string,
  sourceDir: string,
  scopes: ComponentScope[],
  tempRoot: string
): Promise<void> => {
  const keys = new Set(scopes.map((scope) => scope.key));
  const typeDirs = [...new Set(scopes.map((scope) => scope.typeDir))];
  const { stdout } = await execFileAsync('git', ['--literal-pathspecs', 'ls-tree', '-r', '-z', ref, '--', ...typeDirs], {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
  });

  // Each entry is "<mode> <type> <sha>\t<path>", the input format of `update-index --index-info`.
  const entries = stdout.split('\0').filter((entry) => {
    const key = entry && componentScope(sourceDir, entry.slice(entry.indexOf('\t') + 1))?.key;
    return key !== undefined && keys.has(key);
  });
  if (entries.length === 0) {
    return;
  }

  const env = { ...process.env, GIT_INDEX_FILE: path.join(tempRoot, '.sf-df-index') };
  await runWithInput(cwd, ['update-index', '-z', '--index-info'], env, `${entries.join('\0')}\0`);
  await checkoutIndex(cwd, tempRoot, env);
};

export class SnapshotManager {
  private readonly cleanupDirs = new Set<string>();

  public constructor(private readonly repoRoot: string, private readonly sourceDir: string) {}

  // With `paths`, only the components of those files are extracted; without, the whole sourceDir.
  public async createFrom(ref: string, paths?: string[]): Promise<SnapshotRef> {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'sf-df-delta-'));
    this.cleanupDirs.add(rootDir);
    await copyForceIgnore(this.repoRoot, ref, rootDir);

    const scopes = paths?.map((filePath) => componentScope(this.sourceDir, filePath));
    if (scopes?.every((scope): scope is ComponentScope => scope !== undefined)) {
      if (scopes.length > 0) {
        await extractScopes(this.repoRoot, ref, this.sourceDir, scopes, rootDir);
      }
    } else {
      await extractSourceDir(this.repoRoot, ref, this.sourceDir, rootDir);
    }

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
