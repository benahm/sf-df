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

export type ResolvedOperation = {
  operation: ProcessOperation;
  relativePath: string;
  resolvedMetadata?: ResolvedMetadataComponent;
  manifestEntry?: ManifestEntry;
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

// What happens to a component in the org: `deactivate` replaces a deletion the Metadata API refuses (Flow, RecordType).
// A component edited inside a container file (a label of CustomLabels...) is `modify`, even when the element is new.
export type DeltaComponentAction = 'add' | 'modify' | 'rename' | 'delete' | 'deactivate';

export type DeltaComponent = ManifestEntry & {
  action: DeltaComponentAction;
  manifest: 'package' | 'destructive';
  // The changed git files behind the component, relative to the repository root.
  files: string[];
};

// A changed file that puts nothing in the manifests: excluded by .forceignore, or a change with no effect on the org
// (pure reformatting, a deleted translation...).
export type DeltaSkippedFile = {
  path: string;
  reason: 'forceignore' | 'no-change';
};

export type DeltaSummary = {
  packageDir: string;
  destructiveDir?: string;
  packageManifestPath: string;
  destructiveManifestPath?: string;
  processedChanges: number;
  countsByStatus: Record<GitChangeStatus, number>;
  countsByStrategy: Record<string, number>;
  components: DeltaComponent[];
  skippedFiles: DeltaSkippedFile[];
  warnings: string[];
};

export type DeltaResult = DeltaSummary & {
  from: string;
  to?: string;
  sourceDir: string;
};

export type MetadataDeltaStrategy = {
  readonly name: string;
  readonly isFallback?: boolean;
  supports(operation: ResolvedOperation): boolean;
  build(operation: ResolvedOperation): Promise<DeltaArtifacts | undefined>;
};
