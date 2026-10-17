import { stat } from 'node:fs/promises';
import path from 'node:path';

import { collectFilesRecursively, pathExists } from '../fs.js';
import type { DeltaArtifacts, MetadataDeltaStrategy, ResolvedOperation } from '../types.js';

const toAbsolutePath = (rootDir: string, relativePath: string): string => path.join(rootDir, relativePath);

// Jest tests live inside LWC bundles but are not deployable metadata.
const isExcludedFromBundle = (typeName: string, relativePath: string): boolean =>
  typeName === 'LightningComponentBundle' && relativePath.split('/').includes('__tests__');

export class GenericFileStrategy implements MetadataDeltaStrategy {
  public readonly name = 'generic';
  public readonly isFallback = true;

  public supports(): boolean {
    return true;
  }

  public async build({ operation, resolvedMetadata: resolved, manifestEntry }: ResolvedOperation): Promise<DeltaArtifacts | undefined> {
    const snapshot = operation.sourceSnapshot;

    if (operation.kind === 'destructive') {
      if (!manifestEntry) {
        return {
          dedupeKey: `destructive:${operation.relativePath}`,
          warnings: [`Unable to resolve metadata type for deleted path ${operation.relativePath}.`],
        };
      }

      // A file such as a field translation is not a component of its own: SDR resolves it to its parent
      // (the whole object translation), which must not be deleted while it still exists.
      if (resolved && (await this.isPartOfSurvivingParent(resolved, operation))) {
        return {
          dedupeKey: `destructive-part:${operation.relativePath}`,
          warnings: [
            `${operation.relativePath} was deleted, but it belongs to ${manifestEntry.type}:${manifestEntry.fullName}, which still exists; the Metadata API cannot remove it on its own, remove it manually in the org if needed.`,
          ],
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

    const packageFileCopies = new Map<string, string>(
      packageEntries.flat().filter(([relativePath]) => !isExcludedFromBundle(resolved.typeName, relativePath))
    );

    return {
      dedupeKey: `package:${resolved.typeName}:${resolved.fullName}`,
      packageFileCopies,
      packageManifestEntries: manifestEntry
        ? [manifestEntry]
        : [{ type: resolved.typeName, fullName: resolved.fullName }],
    };
  }

  private async isPartOfSurvivingParent(
    resolved: NonNullable<ResolvedOperation['resolvedMetadata']>,
    operation: ResolvedOperation['operation']
  ): Promise<boolean> {
    const parentXml = resolved.xmlRelativePath;
    if (
      resolved.component?.type.strategies?.adapter !== 'decomposed' ||
      !parentXml ||
      parentXml === operation.relativePath ||
      !operation.targetSnapshot
    ) {
      return false;
    }

    return pathExists(path.join(operation.targetSnapshot.rootDir, parentXml));
  }
}
