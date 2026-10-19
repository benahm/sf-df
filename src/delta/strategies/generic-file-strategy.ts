import { stat } from 'node:fs/promises';
import path from 'node:path';

import { collectFilesRecursively, pathExists } from '../fs.js';
import type { DeltaArtifacts, MetadataDeltaStrategy, ResolvedOperation } from '../types.js';

const toAbsolutePath = (rootDir: string, relativePath: string): string => path.join(rootDir, relativePath);

// Jest tests live inside LWC bundles but are not deployable metadata.
const isExcludedFromBundle = (typeName: string, relativePath: string): boolean =>
  typeName === 'LightningComponentBundle' && relativePath.split('/').includes('__tests__');

// A file such as a field translation is not a component of its own: SDR resolves it to its decomposed parent
// (the whole object translation), which must not be deleted while it still exists.
const isPartOfSurvivingParent = async (
  resolved: NonNullable<ResolvedOperation['resolvedMetadata']>,
  operation: ResolvedOperation['operation']
): Promise<boolean> => {
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
};

// A decomposed component (CustomObject, CustomObjectTranslation, Bot) is one folder of files that SDR resolves as a
// whole. Only the changed file ships, with the parent file the deployment requires: the other children did not
// change, and deploying a parent never removes the children it does not carry.
const changedFilesOf = (
  resolved: NonNullable<ResolvedOperation['resolvedMetadata']>,
  relativePath: string
): string[] | undefined => {
  if (resolved.component?.type.strategies?.adapter !== 'decomposed' || !resolved.contentRelativePaths.includes(relativePath)) {
    return undefined;
  }

  return [...new Set([resolved.xmlRelativePath, relativePath].filter((entry): entry is string => Boolean(entry)))];
};

// Verified on a sandbox: "The StandardValueSet called 'LeadSource' is standard and cannot be deleted". Listing one
// would make the whole deployment fail, so a deleted file is only reported.
const UNDELETABLE_TYPES = new Set(['StandardValueSet']);

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

      if (UNDELETABLE_TYPES.has(manifestEntry.type)) {
        return {
          dedupeKey: `destructive-refused:${manifestEntry.type}:${manifestEntry.fullName}`,
          warnings: [
            `${manifestEntry.type}:${manifestEntry.fullName} cannot be deleted through the Metadata API; it is left in the org.`,
          ],
        };
      }

      if (resolved && (await isPartOfSurvivingParent(resolved, operation))) {
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

    const changedFiles = changedFilesOf(resolved, operation.relativePath);
    const packageEntries = await Promise.all(
      (changedFiles ?? resolved.contentRelativePaths).map(async (relativeSourcePath) => {
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
      // Each changed child of a decomposed component brings its own file.
      dedupeKey: `package:${resolved.typeName}:${resolved.fullName}${changedFiles ? `:${operation.relativePath}` : ''}`,
      packageFileCopies,
      packageManifestEntries: manifestEntry
        ? [manifestEntry]
        : [{ type: resolved.typeName, fullName: resolved.fullName }],
    };
  }
}
