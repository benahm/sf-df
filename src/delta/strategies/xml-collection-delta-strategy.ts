import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { pathExists } from '../fs.js';
import { diffCompositeXml, type XmlCollectionRules } from '../xml.js';
import type { DeltaArtifacts, ManifestEntry, MetadataDeltaStrategy, ResolvedOperation } from '../types.js';
import type { XmlDiffResult } from '../xml.js';

export type XmlStrategyOptions = {
  name: string;
  metadataTypes: string[];
  rootName: string;
  rules: XmlCollectionRules;
  alwaysInclude?: string[];
  supportsDestructive?: boolean;
  qualifyChildNames?: boolean;
};

export class XmlCollectionDeltaStrategy implements MetadataDeltaStrategy {
  public readonly name: string;

  private readonly metadataTypes: Set<string>;
  private readonly rootName: string;
  private readonly rules: XmlCollectionRules;
  private readonly alwaysInclude: string[];
  private readonly supportsDestructive: boolean;
  private readonly qualifyChildNames: boolean;

  public constructor(options: XmlStrategyOptions) {
    this.name = options.name;
    this.metadataTypes = new Set(options.metadataTypes);
    this.rootName = options.rootName;
    this.rules = options.rules;
    this.alwaysInclude = options.alwaysInclude ?? [];
    this.supportsDestructive = options.supportsDestructive ?? false;
    this.qualifyChildNames = options.qualifyChildNames ?? false;
  }

  public supports({ resolvedMetadata, manifestEntry }: ResolvedOperation): boolean {
    const metadataType = resolvedMetadata?.typeName ?? manifestEntry?.type;
    return metadataType ? this.metadataTypes.has(metadataType) : false;
  }

  public async build({ operation, manifestEntry }: ResolvedOperation): Promise<DeltaArtifacts | undefined> {
    if (operation.kind === 'destructive' && !this.supportsDestructive) {
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

    const currentSnapshot = operation.sourceSnapshot;
    const absoluteCurrentPath = path.join(currentSnapshot.rootDir, operation.relativePath);
    const currentXml = await readFile(absoluteCurrentPath, 'utf8');

    const compareSnapshot = operation.targetSnapshot;
    const comparePath = compareSnapshot ? path.join(compareSnapshot.rootDir, operation.relativePath) : undefined;
    const compareXml = comparePath && (await pathExists(comparePath)) ? await readFile(comparePath, 'utf8') : '';

    const [oldXml, newXml] = operation.kind === 'package' ? [compareXml, currentXml] : [currentXml, compareXml];
    const diff = diffCompositeXml(oldXml, newXml, this.rootName, this.rules, this.alwaysInclude);

    if (operation.kind === 'package') {
      if (!diff.packageXml) {
        if (!diff.destructiveXml || !manifestEntry) {
          return undefined;
        }

        return {
          dedupeKey: `${this.name}:package:${operation.relativePath}`,
          destructiveTextFiles: new Map([[operation.relativePath, diff.destructiveXml]]),
          destructiveManifestEntries: this.toDestructiveEntries(diff, manifestEntry),
        };
      }

      return {
        dedupeKey: `${this.name}:package:${operation.relativePath}`,
        packageTextFiles: new Map([[operation.relativePath, diff.packageXml]]),
        packageManifestEntries: manifestEntry ? [manifestEntry] : undefined,
        destructiveTextFiles: diff.destructiveXml
          ? new Map([[operation.relativePath, diff.destructiveXml]])
          : undefined,
        destructiveManifestEntries:
          diff.destructiveXml && manifestEntry ? this.toDestructiveEntries(diff, manifestEntry) : undefined,
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
      destructiveManifestEntries: this.toDestructiveEntries(diff, manifestEntry),
    };
  }

  // Deleted children are listed by their own type (CustomLabel, WorkflowRule, ...) so destructiveChanges.xml
  // never targets the whole container; collections without a child type keep the parent entry.
  private toDestructiveEntries(diff: XmlDiffResult, manifestEntry: ManifestEntry): ManifestEntry[] {
    const childEntries = diff.deletedItems.flatMap(({ fieldName, key }) => {
      const childType = this.rules[fieldName]?.childType;
      if (!childType || !key) {
        return [];
      }

      return [{ type: childType, fullName: this.qualifyChildNames ? `${manifestEntry.fullName}.${key}` : key }];
    });

    return childEntries.length > 0 ? childEntries : [manifestEntry];
  }
}
