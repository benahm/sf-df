import type { SourceComponent } from '@salesforce/source-deploy-retrieve';

export type GitChangeStatus = 'add' | 'modify' | 'delete' | 'rename';
export type OperationKind = 'package' | 'destructive';

export type GitChange = {
  status: GitChangeStatus;
  path: string;
  previousPath?: string;
};

export type SnapshotRef =
  | {
      kind: 'git';
      ref: string;
      rootDir: string;
      sourceDir: string;
      sourceDirAbs: string;
    }
  | {
      kind: 'workspace';
      rootDir: string;
      sourceDir: string;
      sourceDirAbs: string;
    };

export type ManifestEntry = {
  fullName: string;
  type: string;
};

export type ProcessOperation = {
  change: GitChange;
  kind: OperationKind;
  relativePath: string;
  sourceSnapshot: SnapshotRef;
  targetSnapshot?: SnapshotRef;
};

export type ResolvedMetadataComponent = {
  typeName: string;
  fullName: string;
  rootRelativePath: string;
  xmlRelativePath?: string;
  contentRelativePaths: string[];
  component?: SourceComponent;
  isAddressable: boolean;
};

export type DeltaArtifacts = {
  dedupeKey: string;
  packageFileCopies?: Map<string, string>;
  packageTextFiles?: Map<string, string>;
  destructiveTextFiles?: Map<string, string>;
  packageManifestEntries?: ManifestEntry[];
  destructiveManifestEntries?: ManifestEntry[];
  warnings?: string[];
};

export type DeltaSummary = {
  packageDir: string;
  destructiveDir?: string;
  packageManifestPath: string;
  destructiveManifestPath?: string;
  processedChanges: number;
  countsByStatus: Record<GitChangeStatus, number>;
  countsByStrategy: Record<string, number>;
  warnings: string[];
};

export type DeltaResult = DeltaSummary & {
  from: string;
  to?: string;
  sourceDir: string;
};

export type MetadataDeltaStrategy = {
  readonly name: string;
  supports(relativePath: string): boolean;
  build(operation: ProcessOperation): Promise<DeltaArtifacts | undefined>;
};
