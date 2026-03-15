import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { diffCompositeXml, type XmlCollectionRules } from '../xml.js';
import { resolveManifestEntry } from '../metadata-resolver.js';
import type { DeltaArtifacts, MetadataDeltaStrategy, ProcessOperation } from '../types.js';

export type XmlStrategyOptions = {
  name: string;
  matcher: (relativePath: string) => boolean;
  rootName: string;
  rules: XmlCollectionRules;
  alwaysInclude?: string[];
  supportsDestructive?: boolean;
};

export class XmlCollectionDeltaStrategy implements MetadataDeltaStrategy {
  public readonly name: string;

  private readonly matcher: XmlStrategyOptions['matcher'];
  private readonly rootName: string;
  private readonly rules: XmlCollectionRules;
  private readonly alwaysInclude: string[];
  private readonly supportsDestructive: boolean;

  public constructor(options: XmlStrategyOptions) {
    this.name = options.name;
    this.matcher = options.matcher;
    this.rootName = options.rootName;
    this.rules = options.rules;
    this.alwaysInclude = options.alwaysInclude ?? [];
    this.supportsDestructive = options.supportsDestructive ?? false;
  }

  public supports(relativePath: string): boolean {
    return this.matcher(relativePath);
  }

  public async build(operation: ProcessOperation): Promise<DeltaArtifacts | undefined> {
    if (operation.kind === 'destructive' && !this.supportsDestructive) {
      const manifestEntry = await resolveManifestEntry(operation.sourceSnapshot, operation.relativePath);
      return manifestEntry
        ? {
            dedupeKey: `${this.name}:warning:${manifestEntry.type}:${manifestEntry.fullName}`,
            warnings: [
              `${this.name} does not produce partial destructive XML for ${manifestEntry.type}:${manifestEntry.fullName}; manifest-only delete was kept.`,
            ],
            destructiveManifestEntries: [manifestEntry],
          }
        : undefined;
    }

    const currentSnapshot = operation.kind === 'package' ? operation.sourceSnapshot : operation.sourceSnapshot;
    const absoluteCurrentPath = path.join(currentSnapshot.rootDir, operation.relativePath);
    const currentXml = await readFile(absoluteCurrentPath, 'utf8');

    const compareSnapshot = operation.targetSnapshot;
    const comparePath = compareSnapshot ? path.join(compareSnapshot.rootDir, operation.relativePath) : undefined;
    const compareXml = comparePath ? await readFile(comparePath, 'utf8') : '';

    const [oldXml, newXml] = operation.kind === 'package' ? [compareXml, currentXml] : [currentXml, compareXml];
    const diff = diffCompositeXml(oldXml, newXml, this.rootName, this.rules, this.alwaysInclude);
    const manifestEntry = await resolveManifestEntry(currentSnapshot, operation.relativePath);

    if (operation.kind === 'package') {
      if (!diff.packageXml) {
        if (!diff.destructiveXml || !manifestEntry) {
          return undefined;
        }

        return {
          dedupeKey: `${this.name}:package:${operation.relativePath}`,
          destructiveTextFiles: new Map([[operation.relativePath, diff.destructiveXml]]),
          destructiveManifestEntries: [manifestEntry],
        };
      }

      return {
        dedupeKey: `${this.name}:package:${operation.relativePath}`,
        packageTextFiles: new Map([[operation.relativePath, diff.packageXml]]),
        packageManifestEntries: manifestEntry ? [manifestEntry] : undefined,
        destructiveTextFiles: diff.destructiveXml
          ? new Map([[operation.relativePath, diff.destructiveXml]])
          : undefined,
        destructiveManifestEntries: diff.destructiveXml && manifestEntry ? [manifestEntry] : undefined,
      };
    }

    if (!diff.destructiveXml || !manifestEntry) {
      return manifestEntry
        ? {
            dedupeKey: `${this.name}:destructive:${manifestEntry.type}:${manifestEntry.fullName}`,
            destructiveManifestEntries: [manifestEntry],
          }
        : undefined;
    }

    return {
      dedupeKey: `${this.name}:destructive:${operation.relativePath}`,
      destructiveTextFiles: new Map([[operation.relativePath, diff.destructiveXml]]),
      destructiveManifestEntries: [manifestEntry],
    };
  }
}
