import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { generateDelta, type DeltaSource } from '../../../src/delta/engine.js';
import type { DeltaResult, GitChange } from '../../../src/delta/types.js';

// A throwaway repository to run `generateDelta` on, and a readable view of what it wrote. Two flavours share one API:
// - FolderDeltaRepo (the default) keeps each commit as a plain folder and computes the changed files itself: no git
//   process, a test runs in milliseconds.
// - GitDeltaRepo (`useDeltaRepo({ git: true })`) is a real git repository, for what depends on git itself: rename
//   detection, untracked and ignored files, `git` commands in the test.

export const SOURCE_DIR = 'force-app/main/default';

const OUTPUT_DIR = 'tmp-output';

const exists = async (absolutePath: string): Promise<boolean> =>
  stat(absolutePath).then(
    () => true,
    () => false
  );

const listFiles = async (directory: string): Promise<string[]> => {
  if (!(await exists(directory))) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'))
    .sort();
};

// Members of package.xml / destructiveChanges.xml as "Type:fullName".
export const parseManifest = (xml: string): string[] =>
  [...xml.matchAll(/<types>([\s\S]*?)<\/types>/g)].flatMap(([, block]) => {
    const type = /<name>([^<]*)<\/name>/.exec(block)?.[1] ?? '';
    return [...block.matchAll(/<members>([^<]*)<\/members>/g)].map(([, member]) => `${type}:${member}`);
  });

export type DeltaOutput = {
  result: DeltaResult;
  // "Type:fullName" entries of package.xml and destructiveChanges.xml.
  package: string[];
  destructive: string[];
  // Files written below the source folder, relative to it.
  packageFiles: string[];
  destructiveFiles: string[];
  warnings: string;
  packageFile(relativePath: string): Promise<string>;
  destructiveFile(relativePath: string): Promise<string>;
};

export abstract class DeltaRepo {
  protected constructor(public readonly root: string) {}

  protected get outputDir(): string {
    return path.join(this.root, OUTPUT_DIR);
  }

  public async write(files: Record<string, string>): Promise<void> {
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(this.root, SOURCE_DIR, relativePath);
      // eslint-disable-next-line no-await-in-loop
      await mkdir(path.dirname(absolutePath), { recursive: true });
      // eslint-disable-next-line no-await-in-loop
      await writeFile(absolutePath, content, 'utf8');
    }
  }

  public async remove(...relativePaths: string[]): Promise<void> {
    await Promise.all(
      relativePaths.map((relativePath) =>
        rm(path.join(this.root, SOURCE_DIR, relativePath), { recursive: true, force: true })
      )
    );
  }

  public async baseline(files: Record<string, string>): Promise<string> {
    await this.write(files);
    return this.commit('base');
  }

  // Delta from `from` (default HEAD) to `to` (default: the working tree as it is on disk, staged or not).
  public async delta(options: { from?: string; to?: string } = {}): Promise<DeltaOutput> {
    await rm(this.outputDir, { recursive: true, force: true });

    const packageDir = path.join(this.outputDir, 'package');
    const destructiveDir = path.join(this.outputDir, 'destructive');
    const result = await generateDelta({
      repoRoot: this.root,
      from: options.from ?? 'HEAD',
      to: options.to,
      sourceDir: SOURCE_DIR,
      deployDir: packageDir,
      destructiveDir,
      source: this.source(options.from ?? 'HEAD', options.to),
    });
    const readManifest = async (manifestPath: string | undefined): Promise<string[]> =>
      manifestPath && (await exists(manifestPath)) ? parseManifest(await readFile(manifestPath, 'utf8')) : [];

    return {
      result,
      package: await readManifest(result.packageManifestPath),
      destructive: await readManifest(result.destructiveManifestPath),
      packageFiles: await listFiles(path.join(packageDir, SOURCE_DIR)),
      destructiveFiles: await listFiles(path.join(destructiveDir, SOURCE_DIR)),
      warnings: result.warnings.join('\n'),
      packageFile: (relativePath) => readFile(path.join(packageDir, SOURCE_DIR, relativePath), 'utf8'),
      destructiveFile: (relativePath) => readFile(path.join(destructiveDir, SOURCE_DIR, relativePath), 'utf8'),
    };
  }

  public async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  public abstract git(...args: string[]): string;
  public abstract rename(from: string, to: string): void;
  // Commits everything and returns the commit id.
  public abstract commit(message?: string): string;
  // Undefined: generateDelta reads git.
  protected abstract source(from: string, to?: string): DeltaSource | undefined;
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

// Each git process costs 100-250 ms on Windows, and tests create hundreds of repositories: they are copied from an
// empty, configured repository built once per process instead of running `git init` and `git config` every time.
let templateRoot: Promise<string> | undefined;

const createTemplate = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'sf-df-delta-template-'));
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  // An empty --template leaves out the sample hooks: fewer files to copy.
  git(root, 'init', '-q', '--template=');
  git(root, 'config', 'user.email', 'delta@example.com');
  git(root, 'config', 'user.name', 'Delta Tests');
  git(root, 'config', 'core.autocrlf', 'false');
  // `git commit` starts `git maintenance run --auto` in another process: ~180 ms per commit on Windows.
  git(root, 'config', 'maintenance.auto', 'false');
  git(root, 'config', 'gc.auto', '0');
  await writeFile(path.join(root, '.gitignore'), `${OUTPUT_DIR}/\n`, 'utf8');
  return root;
};

export class GitDeltaRepo extends DeltaRepo {
  public static async create(): Promise<GitDeltaRepo> {
    templateRoot ??= createTemplate();
    const repo = new GitDeltaRepo(await mkdtemp(path.join(tmpdir(), 'sf-df-delta-')));
    await cp(await templateRoot, repo.root, { recursive: true });
    return repo;
  }

  public git(...args: string[]): string {
    return git(this.root, ...args);
  }

  public rename(from: string, to: string): void {
    this.git('mv', `${SOURCE_DIR}/${from}`, `${SOURCE_DIR}/${to}`);
  }

  public commit(message = 'change'): string {
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.head();
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  protected source(): undefined {
    return undefined;
  }

  // Same as `git rev-parse HEAD` without a git process: the branch ref stays a loose file, nothing packs it.
  private head(): string {
    const head = readFileSync(path.join(this.root, '.git', 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: ') ? readFileSync(path.join(this.root, '.git', head.slice(5)), 'utf8').trim() : head;
  }
}

// Content of every file below the source folder, by path from the root (the paths git reports).
const filesOf = (root: string): Map<string, Buffer> => {
  const directory = path.join(root, SOURCE_DIR);
  if (!existsSync(directory)) {
    return new Map();
  }

  return new Map(
    readdirSync(directory, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const absolutePath = path.join(entry.parentPath, entry.name);
        return [path.relative(root, absolutePath).replaceAll(path.sep, '/'), readFileSync(absolutePath)] as const;
      })
  );
};

export class FolderDeltaRepo extends DeltaRepo {
  private readonly commits: string[] = [];
  // Renames made with rename(), by the number of commits that existed when they were made: git detects them from
  // the content, this flavour only knows the ones the test declared.
  private readonly renames: Array<{ from: string; to: string; afterCommit: number }> = [];

  private constructor(root: string, private readonly commitsDir: string) {
    super(root);
  }

  public static async create(): Promise<FolderDeltaRepo> {
    const base = await mkdtemp(path.join(tmpdir(), 'sf-df-delta-'));
    const repo = new FolderDeltaRepo(path.join(base, 'work'), path.join(base, 'commits'));
    await mkdir(repo.root, { recursive: true });
    return repo;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  public git(): string {
    throw new Error('This test needs a real git repository: use useDeltaRepo({ git: true }).');
  }

  public rename(from: string, to: string): void {
    const target = path.join(this.root, SOURCE_DIR, to);
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(path.join(this.root, SOURCE_DIR, from), target);
    this.renames.push({ from: `${SOURCE_DIR}/${from}`, to: `${SOURCE_DIR}/${to}`, afterCommit: this.commits.length });
  }

  public commit(): string {
    const id = `commit-${this.commits.length + 1}`;
    const directory = path.join(this.commitsDir, id);
    cpSync(this.root, directory, {
      recursive: true,
      filter: (source) => path.relative(this.root, source).split(path.sep)[0] !== OUTPUT_DIR,
    });
    this.commits.push(directory);
    return id;
  }

  public override async cleanup(): Promise<void> {
    await rm(path.dirname(this.root), { recursive: true, force: true });
  }

  protected source(from: string, to?: string): DeltaSource {
    const fromIndex = this.commitIndex(from);
    const toIndex = to ? this.commitIndex(to) : Infinity;
    const oldRoot = this.commits[fromIndex];
    const newRoot = to ? this.commits[toIndex] : this.root;
    const snapshot = (rootDir: string): { kind: 'workspace'; rootDir: string; sourceDir: string; sourceDirAbs: string } => ({
      kind: 'workspace',
      rootDir,
      sourceDir: SOURCE_DIR,
      sourceDirAbs: path.join(rootDir, SOURCE_DIR),
    });

    return {
      getChanges: async () => this.changes(oldRoot, newRoot, fromIndex, toIndex),
      createSnapshots: async () => [snapshot(oldRoot), snapshot(newRoot)],
    };
  }

  // HEAD, HEAD~n or an id returned by commit(), as an index in this.commits.
  private commitIndex(ref: string): number {
    const relative = /^HEAD(?:~(\d+))?$/.exec(ref);
    const index = relative ? this.commits.length - 1 - Number(relative[1] ?? 0) : this.commits.findIndex((directory) => path.basename(directory) === ref);
    if (index < 0 || index >= this.commits.length) {
      throw new Error(`Unknown commit ${ref}`);
    }

    return index;
  }

  // What `git diff --name-status -M` reports between the two folders, in its order (by path).
  private changes(oldRoot: string, newRoot: string, fromIndex: number, toIndex: number): GitChange[] {
    const oldFiles = filesOf(oldRoot);
    const newFiles = filesOf(newRoot);
    const changes: GitChange[] = [];

    for (const { from, to, afterCommit } of this.renames) {
      if (
        afterCommit > fromIndex &&
        afterCommit <= toIndex &&
        oldFiles.has(from) &&
        !newFiles.has(from) &&
        newFiles.has(to) &&
        !oldFiles.has(to)
      ) {
        changes.push({ status: 'rename', previousPath: from, path: to });
        oldFiles.delete(from);
        newFiles.delete(to);
      }
    }

    for (const [filePath, content] of newFiles) {
      const previous = oldFiles.get(filePath);
      if (!previous) {
        changes.push({ status: 'add', path: filePath });
      } else if (!previous.equals(content)) {
        changes.push({ status: 'modify', path: filePath });
      }
    }

    for (const filePath of oldFiles.keys()) {
      if (!newFiles.has(filePath)) {
        changes.push({ status: 'delete', path: filePath });
      }
    }

    return changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }
}

// Registers a fresh repository for each test of the enclosing describe.
export const useDeltaRepo = (options: { git?: boolean } = {}): { readonly repo: DeltaRepo } => {
  const holder: { repo?: DeltaRepo } = {};
  beforeEach(async () => {
    holder.repo = options.git ? await GitDeltaRepo.create() : await FolderDeltaRepo.create();
  });
  afterEach(async () => {
    await holder.repo?.cleanup();
  });
  return {
    get repo(): DeltaRepo {
      return holder.repo!;
    },
  };
};
