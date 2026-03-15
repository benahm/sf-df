import { stat } from 'node:fs/promises';
import path from 'node:path';

import { collectFilesRecursively, pathExists } from '../fs.js';
import { resolveManifestEntry, resolveMetadataFromPath } from '../metadata-resolver.js';
import type { DeltaArtifacts, MetadataDeltaStrategy, ProcessOperation } from '../types.js';

const toAbsolutePath = (rootDir: string, relativePath: string): string => path.join(rootDir, relativePath);

export class GenericFileStrategy implements MetadataDeltaStrategy {
  public readonly name = 'generic';

  // eslint-disable-next-line class-methods-use-this
  public supports(): boolean {
    return true;
  }

  // eslint-disable-next-line class-methods-use-this
  public async build(operation: ProcessOperation): Promise<DeltaArtifacts | undefined> {
    const snapshot = operation.sourceSnapshot;
    const resolved = await resolveMetadataFromPath(snapshot, operation.relativePath);
    const manifestEntry = await resolveManifestEntry(snapshot, operation.relativePath);

    if (operation.kind === 'destructive') {
      if (!manifestEntry) {
        return {
          dedupeKey: `destructive:${operation.relativePath}`,
          warnings: [`Unable to resolve metadata type for deleted path ${operation.relativePath}.`],
        };
      }

      return {
        dedupeKey: `destructive:${manifestEntry.type}:${manifestEntry.fullName}`,
        destructiveManifestEntries: [manifestEntry],
      };
    }

    if (!resolved) {
      return {
        dedupeKey: `package:${operation.relativePath}`,
        warnings: [`Unable to resolve metadata for changed path ${operation.relativePath}.`],
      };
    }

    const packageEntries = await Promise.all(
      resolved.contentRelativePaths.map(async (relativeSourcePath) => {
        const absoluteSourcePath = toAbsolutePath(snapshot.rootDir, relativeSourcePath);
        if (!(await pathExists(absoluteSourcePath))) {
          return [];
        }

        if ((await stat(absoluteSourcePath)).isDirectory()) {
          const files = await collectFilesRecursively(absoluteSourcePath);
          return files.map(
            (absoluteFile) =>
              [path.relative(snapshot.rootDir, absoluteFile).replaceAll(path.sep, '/'), absoluteFile] as const
          );
        }

        return [[relativeSourcePath, absoluteSourcePath] as const];
      })
    );

    const packageFileCopies = new Map<string, string>(packageEntries.flat());

    return {
      dedupeKey: `package:${resolved.typeName}:${resolved.fullName}`,
      packageFileCopies,
      packageManifestEntries: manifestEntry
        ? [manifestEntry]
        : [{ type: resolved.typeName, fullName: resolved.fullName }],
    };
  }
}
