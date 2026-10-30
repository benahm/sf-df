import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ForceIgnore } from '@salesforce/source-deploy-retrieve';

import { dropComponentsOfDeletedObjects } from './destructive-rules.js';
import { copyFileInto, ensureDir, pathExists } from './fs.js';
import { getGitChanges } from './git.js';
import { buildManifestXml, readSourceApiVersion } from './manifest.js';
import { resolvePath } from './metadata-resolver.js';
import { SnapshotManager } from './snapshot.js';
import { StrategyRegistry } from './strategies/strategy-registry.js';
import type {
  DeltaArtifacts,
  DeltaComponent,
  DeltaComponentAction,
  DeltaResult,
  DeltaSummary,
  GitChange,
  GitChangeStatus,
  ManifestEntry,
  OperationKind,
  ProcessOperation,
  ResolvedOperation,
  SnapshotRef,
} from './types.js';

// Operations resolved and built at the same time: enough to hide file system latency, few enough to keep the
// built XML of big Profiles or Translations in memory only a batch at a time.
const BUILD_BATCH_SIZE = 16;

const emptyCountsByStatus =(): Record<GitChangeStatus, number> => ({
  add: 0,
  modify: 0,
  delete: 0,
  rename: 0,
});

// A git change behind a manifest entry, as the operation that built it saw it: `kind` is the side after the
// redirection of a partial bundle delete, `path` the file on that side (the old path of a renamed file when destructive).
type EntrySource = {
  change: GitChange;
  kind: OperationKind;
  path: string;
};

// Manifest entries by `type#fullName`, with the git changes that produced them, in git order.
type ManifestEntries = Map<string, { entry: ManifestEntry; sources: EntrySource[] }>;

const entryKey = ({ type, fullName }: ManifestEntry): string => `${type}#${fullName}`;

const addEntries = (entries: ManifestEntries, manifestEntries: ManifestEntry[] | undefined, source: EntrySource): void => {
  for (const entry of manifestEntries ?? []) {
    const existing = entries.get(entryKey(entry));
    if (existing) {
      existing.sources.push(source);
    } else {
      entries.set(entryKey(entry), { entry, sources: [source] });
    }
  }
};

const packageAction = (sources: EntrySource[]): DeltaComponentAction => {
  // A deletion turned into a deployment: the inactive Flow or RecordType.
  if (sources.some(({ kind }) => kind === 'destructive')) {
    return 'deactivate';
  }

  if (sources.some(({ change }) => change.status === 'rename')) {
    return 'rename';
  }

  // A file deleted from a bundle that still exists redeploys the bundle: a modification.
  return sources.every(({ change }) => change.status === 'add') ? 'add' : 'modify';
};

const toComponent = (
  { entry, sources }: { entry: ManifestEntry; sources: EntrySource[] },
  manifest: DeltaComponent['manifest']
): DeltaComponent => ({
  type: entry.type,
  fullName: entry.fullName,
  action: manifest === 'package' ? packageAction(sources) : 'delete',
  manifest,
  files: [...new Set(sources.map(({ path: filePath }) => filePath))].sort(),
});

// The entries written to destructiveChanges.xml. The children dropped because their object is deleted go away with
// it: their files are listed under the object.
const destructiveComponents = (entries: ManifestEntries): DeltaComponent[] => {
  const kept = new Set(dropComponentsOfDeletedObjects([...entries.values()].map(({ entry }) => entry)).map(entryKey));
  const components: ManifestEntries = new Map(
    [...entries].filter(([key]) => kept.has(key)).map(([key, { entry, sources }]) => [key, { entry, sources: [...sources] }])
  );
  const objects = [...components.values()].filter(({ entry }) => entry.type === 'CustomObject');

  for (const [key, { entry, sources }] of entries) {
    const owner = kept.has(key)
      ? undefined
      : objects.find((object) => [`${object.entry.fullName}.`, `${object.entry.fullName}-`].some((prefix) => entry.fullName.startsWith(prefix)));
    owner?.sources.push(...sources);
  }

  return [...components.values()].map((component) => toComponent(component, 'destructive'));
};

const mergeArtifacts = async (
  artifacts: DeltaArtifacts,
  packageDir: string,
  destructiveDir: string,
  summary: DeltaSummary
): Promise<void> => {
  await Promise.all(
    [...(artifacts.packageFileCopies ?? [])].map(async ([relativePath, absoluteSourcePath]) =>
      copyFileInto(absoluteSourcePath, relativePath, packageDir)
    )
  );

  await Promise.all(
    [...(artifacts.packageTextFiles ?? [])].map(async ([relativePath, content]) => {
      const destinationPath = path.join(packageDir, relativePath);
      await ensureDir(path.dirname(destinationPath));
      await writeFile(destinationPath, content, 'utf8');
    })
  );

  await Promise.all(
    [...(artifacts.destructiveTextFiles ?? [])].map(async ([relativePath, content]) => {
      const destinationPath = path.join(destructiveDir, relativePath);
      await ensureDir(path.dirname(destinationPath));
      await writeFile(destinationPath, content, 'utf8');
    })
  );

  for (const warning of artifacts.warnings ?? []) {
    summary.warnings.push(warning);
  }
};

const normalizeOperations = (
  change: GitChange,
  oldSnapshot: ProcessOperation['sourceSnapshot'],
  newSnapshot: ProcessOperation['sourceSnapshot']
): ProcessOperation[] => {
  if (change.status === 'rename') {
    // A rename becomes a delete + add so strategies can stay focused on one output side at a time.
    return [
      {
        change,
        kind: 'destructive',
        relativePath: change.previousPath!,
        sourceSnapshot: oldSnapshot,
        targetSnapshot: newSnapshot,
      },
      {
        change,
        kind: 'package',
        relativePath: change.path,
        sourceSnapshot: newSnapshot,
        targetSnapshot: oldSnapshot,
      },
    ];
  }

  if (change.status === 'delete') {
    return [
      {
        change,
        kind: 'destructive',
        relativePath: change.path,
        sourceSnapshot: oldSnapshot,
        targetSnapshot: newSnapshot,
      },
    ];
  }

  return [
    {
      change,
      kind: 'package',
      relativePath: change.path,
      sourceSnapshot: newSnapshot,
      targetSnapshot: oldSnapshot,
    },
  ];
};

const resolveOperation = async (operation: ProcessOperation): Promise<ResolvedOperation> => {
  const { resolvedMetadata, manifestEntry } = await resolvePath(operation.sourceSnapshot, operation.relativePath);

  return {
    operation,
    relativePath: operation.relativePath,
    resolvedMetadata,
    manifestEntry,
  };
};

// Types deployed as a whole folder (LWC, Aura, static resources, Aura sites, LWR site views...).
// Decomposed types (CustomObjectTranslation...) also own a folder, but their files are separate
// components and must not trigger a redeploy of the parent.
const BUNDLE_ADAPTERS = new Set(['bundle', 'mixedContent', 'digitalExperience']);

// Files excluded by the project's .forceignore never reach the delta, as with `sf project deploy`.
const forceIgnoreOf = (snapshot: SnapshotRef): ((relativePath: string) => boolean) => {
  const forceIgnore = new ForceIgnore(path.join(snapshot.rootDir, ForceIgnore.FILE_NAME));
  return (relativePath) => forceIgnore.denies(path.join(snapshot.rootDir, relativePath));
};

const isInside = (directory: string, targetPath: string): boolean => {
  const relativePath = path.relative(directory, targetPath);
  return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
};

// Deleting one file of a bundle (LWC, Aura, folder static resource...) changes the bundle, it does not
// delete it: as long as the bundle still exists on the target side, redeploy it instead.
const redirectPartialBundleDelete = async (resolved: ResolvedOperation): Promise<ResolvedOperation> => {
  const { operation, resolvedMetadata } = resolved;
  const bundleDir = resolvedMetadata?.component?.content;
  const xmlRelativePath = resolvedMetadata?.xmlRelativePath;
  const adapter = resolvedMetadata?.component?.type.strategies?.adapter;

  if (
    operation.kind !== 'destructive' ||
    !operation.targetSnapshot ||
    !bundleDir ||
    !xmlRelativePath ||
    !BUNDLE_ADAPTERS.has(adapter ?? '')
  ) {
    return resolved;
  }

  const deletedPath = path.join(operation.sourceSnapshot.rootDir, operation.relativePath);
  if (!isInside(bundleDir, deletedPath) || !(await pathExists(path.join(operation.targetSnapshot.rootDir, xmlRelativePath)))) {
    return resolved;
  }

  return resolveOperation({
    change: operation.change,
    kind: 'package',
    relativePath: xmlRelativePath,
    sourceSnapshot: operation.targetSnapshot,
    targetSnapshot: operation.sourceSnapshot,
  });
};

const contains = (parent: string, child: string): boolean => {
  const relativePath = path.relative(parent, child);
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
};

// Deploying the deploy folder must never pick up the XML of deleted elements, and the other way round.
export const resolveOutputDirs = (deployDir: string, destructiveDir?: string): { packageDir: string; destructiveDir: string } => {
  const packageDir = path.resolve(deployDir);
  const resolvedDestructiveDir = path.resolve(destructiveDir ?? `${packageDir}-destructive`);
  if (contains(packageDir, resolvedDestructiveDir) || contains(resolvedDestructiveDir, packageDir)) {
    throw new Error(
      `The deploy directory (${packageDir}) and the destructive directory (${resolvedDestructiveDir}) must not contain each other.`
    );
  }

  return { packageDir, destructiveDir: resolvedDestructiveDir };
};

// What a delta compares: the changed files, then the two sides they are read from (old, new). By default git:
// `from` against `to` or the working tree. The unit tests pass two plain folders instead, without any git process
// (test/delta/helpers/delta-repo.ts).
export type DeltaSource = {
  getChanges(): Promise<GitChange[]>;
  createSnapshots(changedPaths: string[]): Promise<[SnapshotRef, SnapshotRef]>;
};

const gitSource = (snapshotManager: SnapshotManager, repoRoot: string, from: string, to?: string): DeltaSource => ({
  getChanges: () => getGitChanges(repoRoot, from, to),
  createSnapshots: async (changedPaths) =>
    Promise.all([
      snapshotManager.createFrom(from, changedPaths),
      to ? snapshotManager.createFrom(to, changedPaths) : snapshotManager.createWorkspace(),
    ]),
});

export const generateDelta = async (options: {
  repoRoot: string;
  from: string;
  to?: string;
  sourceDir?: string;
  deployDir: string;
  // Defaults to `<deployDir>-destructive`, next to the deploy folder.
  destructiveDir?: string;
  source?: DeltaSource;
}): Promise<DeltaResult> => {
  const { packageDir, destructiveDir } = resolveOutputDirs(options.deployDir, options.destructiveDir);
  const sourceDir = (options.sourceDir ?? 'force-app/main/default').replaceAll('\\', '/').replace(/\/+$/, '');
  const snapshotManager = new SnapshotManager(options.repoRoot, sourceDir);
  const source = options.source ?? gitSource(snapshotManager, options.repoRoot, options.from, options.to);
  const registry = new StrategyRegistry();
  const packageEntries: ManifestEntries = new Map();
  const destructiveEntries: ManifestEntries = new Map();
  // The artifacts already merged, by dedupe key: a later file of the same component (another file of a bundle...)
  // is only recorded as one of its sources.
  const mergedArtifacts = new Map<string, DeltaArtifacts>();
  const summary: DeltaSummary = {
    packageDir,
    destructiveDir,
    packageManifestPath: path.join(packageDir, 'package.xml'),
    destructiveManifestPath: path.join(destructiveDir, 'destructiveChanges.xml'),
    processedChanges: 0,
    countsByStatus: emptyCountsByStatus(),
    countsByStrategy: {},
    components: [],
    skippedFiles: [],
    warnings: [],
  };

  await ensureDir(packageDir);
  await ensureDir(destructiveDir);

  const sourceChanges = (await source.getChanges()).filter(
    (change) => change.path.startsWith(`${sourceDir}/`) || (change.previousPath?.startsWith(`${sourceDir}/`) ?? false)
  );
  // Both sides only need the components of the changed files: a rename or a partial bundle delete looks up the
  // same component on the other side.
  const changedPaths = sourceChanges.flatMap((change) => (change.previousPath ? [change.previousPath, change.path] : [change.path]));
  const [oldSnapshot, newSnapshot] = await source.createSnapshots(changedPaths);
  const isIgnoredInOld = forceIgnoreOf(oldSnapshot);
  const isIgnoredInNew = forceIgnoreOf(newSnapshot);

  const isIgnored = (change: GitChange): boolean =>
    change.status === 'delete' ? isIgnoredInOld(change.path) : isIgnoredInNew(change.path);
  const gitChanges = sourceChanges.filter((change) => !isIgnored(change));

  try {
    const operations = gitChanges.flatMap((change) => {
      summary.countsByStatus[change.status] += 1;
      return normalizeOperations(change, oldSnapshot, newSnapshot);
    });

    for (let start = 0; start < operations.length; start += BUILD_BATCH_SIZE) {
      // Resolving and building only read the snapshots, so a batch runs in parallel; its results are then merged
      // in git order, which keeps file writes and dedupe decisions deterministic.
      // eslint-disable-next-line no-await-in-loop
      const built = await Promise.all(
        operations.slice(start, start + BUILD_BATCH_SIZE).map(async (operation) => {
          // Resolve metadata once so strategy selection and generic fallback share the same context.
          const resolvedOperation = await redirectPartialBundleDelete(await resolveOperation(operation));
          const strategy = registry.getStrategy(resolvedOperation);
          const entrySource: EntrySource = {
            change: operation.change,
            kind: resolvedOperation.operation.kind,
            path: operation.relativePath,
          };
          return { strategy, entrySource, artifacts: await strategy.build(resolvedOperation) };
        })
      );

      for (const { strategy, entrySource, artifacts } of built) {
        if (!artifacts) {
          continue;
        }

        const merged = mergedArtifacts.get(artifacts.dedupeKey);
        addEntries(packageEntries, (merged ?? artifacts).packageManifestEntries, entrySource);
        addEntries(destructiveEntries, (merged ?? artifacts).destructiveManifestEntries, entrySource);
        if (merged) {
          continue;
        }

        mergedArtifacts.set(artifacts.dedupeKey, artifacts);
        summary.countsByStrategy[strategy.name] = (summary.countsByStrategy[strategy.name] ?? 0) + 1;
        summary.processedChanges += 1;
        // eslint-disable-next-line no-await-in-loop
        await mergeArtifacts(artifacts, packageDir, destructiveDir, summary);
      }
    }

    summary.components = [
      ...[...packageEntries.values()].map((component) => toComponent(component, 'package')),
      ...destructiveComponents(destructiveEntries),
    ];
    const changesInDelta = new Set(
      [...packageEntries.values(), ...destructiveEntries.values()].flatMap(({ sources }) => sources.map(({ change }) => change))
    );
    summary.skippedFiles = [
      ...sourceChanges.filter(isIgnored).map((change) => ({ path: change.path, reason: 'forceignore' as const })),
      ...gitChanges.filter((change) => !changesInDelta.has(change)).map((change) => ({ path: change.path, reason: 'no-change' as const })),
    ];

    const apiVersion = await readSourceApiVersion(options.repoRoot);
    await writeFile(
      summary.packageManifestPath,
      await buildManifestXml([...packageEntries.values()].map(({ entry }) => entry), apiVersion),
      'utf8'
    );

    if (destructiveEntries.size > 0) {
      await writeFile(
        summary.destructiveManifestPath!,
        await buildManifestXml(dropComponentsOfDeletedObjects([...destructiveEntries.values()].map(({ entry }) => entry)), apiVersion),
        'utf8'
      );
      // `sf project deploy start --post-destructive-changes` only works alongside --manifest,
      // so the destructive folder ships the empty package.xml that deployment needs.
      await writeFile(path.join(destructiveDir, 'package.xml'), await buildManifestXml([], apiVersion), 'utf8');
    }
  } finally {
    await snapshotManager.cleanup();
  }

  return {
    from: options.from,
    to: options.to,
    sourceDir,
    ...summary,
  };
};
