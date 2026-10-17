import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { copyFileInto, ensureDir, pathExists } from './fs.js';
import { getGitChanges } from './git.js';
import { buildManifestXml, readSourceApiVersion } from './manifest.js';
import { resolveManifestEntry, resolveMetadataFromPath } from './metadata-resolver.js';
import { SnapshotManager } from './snapshot.js';
import { StrategyRegistry } from './strategies/strategy-registry.js';
import type {
  DeltaArtifacts,
  DeltaResult,
  DeltaSummary,
  GitChange,
  GitChangeStatus,
  ProcessOperation,
  ResolvedOperation,
} from './types.js';

const emptyCountsByStatus = (): Record<GitChangeStatus, number> => ({
  add: 0,
  modify: 0,
  delete: 0,
  rename: 0,
});

const mergeArtifacts = async (
  artifacts: DeltaArtifacts,
  packageDir: string,
  destructiveDir: string,
  summary: DeltaSummary,
  packageEntries: Set<string>,
  destructiveEntries: Set<string>
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

  for (const entry of artifacts.packageManifestEntries ?? []) {
    packageEntries.add(`${entry.type}#${entry.fullName}`);
  }

  for (const entry of artifacts.destructiveManifestEntries ?? []) {
    destructiveEntries.add(`${entry.type}#${entry.fullName}`);
  }

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

const parseManifestSet = (entries: Set<string>): Array<{ type: string; fullName: string }> =>
  [...entries].map((encoded) => {
    const [type, fullName] = encoded.split('#');
    return { type, fullName };
  });

const resolveOperation = async (operation: ProcessOperation): Promise<ResolvedOperation> => {
  const [resolvedMetadata, manifestEntry] = await Promise.all([
    resolveMetadataFromPath(operation.sourceSnapshot, operation.relativePath),
    resolveManifestEntry(operation.sourceSnapshot, operation.relativePath),
  ]);

  return {
    operation,
    relativePath: operation.relativePath,
    resolvedMetadata,
    manifestEntry,
  };
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

  if (operation.kind !== 'destructive' || !operation.targetSnapshot || !bundleDir || !xmlRelativePath) {
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

export const generateDelta = async (options: {
  repoRoot: string;
  from: string;
  to?: string;
  sourceDir?: string;
  outputDir: string;
}): Promise<DeltaResult> => {
  const sourceDir = (options.sourceDir ?? 'force-app/main/default').replaceAll('\\', '/').replace(/\/+$/, '');
  const snapshotManager = new SnapshotManager(options.repoRoot, sourceDir);
  const registry = new StrategyRegistry();
  const packageDir = path.join(options.outputDir, 'package');
  const destructiveDir = path.join(options.outputDir, 'destructive');
  const packageEntries = new Set<string>();
  const destructiveEntries = new Set<string>();
  const dedupeKeys = new Set<string>();
  const summary: DeltaSummary = {
    packageDir,
    destructiveDir,
    packageManifestPath: path.join(packageDir, 'package.xml'),
    destructiveManifestPath: path.join(destructiveDir, 'destructiveChanges.xml'),
    processedChanges: 0,
    countsByStatus: emptyCountsByStatus(),
    countsByStrategy: {},
    warnings: [],
  };

  await ensureDir(packageDir);
  await ensureDir(destructiveDir);

  const gitChanges = (await getGitChanges(options.repoRoot, options.from, options.to)).filter(
    (change) => change.path.startsWith(`${sourceDir}/`) || (change.previousPath?.startsWith(`${sourceDir}/`) ?? false)
  );

  const oldSnapshot = await snapshotManager.createFrom(options.from);
  const newSnapshot = options.to ? await snapshotManager.createFrom(options.to) : snapshotManager.createWorkspace();

  try {
    for (const change of gitChanges) {
      summary.countsByStatus[change.status] += 1;
      const operations = normalizeOperations(change, oldSnapshot, newSnapshot);

      for (const operation of operations) {
        // Resolve metadata once so strategy selection and generic fallback share the same context.
        // eslint-disable-next-line no-await-in-loop
        const resolvedOperation = await redirectPartialBundleDelete(await resolveOperation(operation));
        const strategy = registry.getStrategy(resolvedOperation);
        // Strategy execution stays sequential so file writes and dedupe decisions remain deterministic.
        // eslint-disable-next-line no-await-in-loop
        const artifacts = await strategy.build(resolvedOperation);
        if (!artifacts || dedupeKeys.has(artifacts.dedupeKey)) {
          continue;
        }

        dedupeKeys.add(artifacts.dedupeKey);
        summary.countsByStrategy[strategy.name] = (summary.countsByStrategy[strategy.name] ?? 0) + 1;
        summary.processedChanges += 1;
        // eslint-disable-next-line no-await-in-loop
        await mergeArtifacts(artifacts, packageDir, destructiveDir, summary, packageEntries, destructiveEntries);
      }
    }

    const apiVersion = await readSourceApiVersion(options.repoRoot);
    await writeFile(
      summary.packageManifestPath,
      await buildManifestXml(parseManifestSet(packageEntries), apiVersion),
      'utf8'
    );

    if (destructiveEntries.size > 0) {
      await writeFile(
        summary.destructiveManifestPath!,
        await buildManifestXml(parseManifestSet(destructiveEntries), apiVersion),
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
