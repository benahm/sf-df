import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { generateDelta } from '../../../src/delta/engine.js';
import type { DeltaResult } from '../../../src/delta/types.js';

// A throwaway git repository to run `generateDelta` on, and a readable view of what it wrote.

export const SOURCE_DIR = 'force-app/main/default';

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
  await writeFile(path.join(root, '.gitignore'), 'tmp-output/\n', 'utf8');
  return root;
};

export class DeltaRepo {
  private constructor(public readonly root: string) {}

  private get outputDir(): string {
    return path.join(this.root, 'tmp-output');
  }

  public static async create(): Promise<DeltaRepo> {
    templateRoot ??= createTemplate();
    const repo = new DeltaRepo(await mkdtemp(path.join(tmpdir(), 'sf-df-delta-')));
    await cp(await templateRoot, repo.root, { recursive: true });
    return repo;
  }

  public git(...args: string[]): string {
    return git(this.root, ...args);
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

  public rename(from: string, to: string): void {
    this.git('mv', `${SOURCE_DIR}/${from}`, `${SOURCE_DIR}/${to}`);
  }

  // Commits everything and returns the commit sha.
  public commit(message = 'change'): string {
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.head();
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

  // Same as `git rev-parse HEAD` without a git process: the branch ref stays a loose file, nothing packs it.
  private head(): string {
    const head = readFileSync(path.join(this.root, '.git', 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: ') ? readFileSync(path.join(this.root, '.git', head.slice(5)), 'utf8').trim() : head;
  }
}

// Registers a fresh repository for each test of the enclosing describe.
export const useDeltaRepo = (): { readonly repo: DeltaRepo } => {
  const holder: { repo?: DeltaRepo } = {};
  beforeEach(async () => {
    holder.repo = await DeltaRepo.create();
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
