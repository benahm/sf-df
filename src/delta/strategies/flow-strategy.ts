import path from 'node:path';

import type { DeltaArtifacts, MetadataDeltaStrategy, ResolvedOperation } from '../types.js';
import { GenericFileStrategy } from './generic-file-strategy.js';

const inactiveFlowDefinition = `<?xml version="1.0" encoding="UTF-8"?>
<FlowDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
    <activeVersionNumber>0</activeVersionNumber>
</FlowDefinition>
`;

// Verified on a sandbox: destructiveChanges cannot delete a Flow by name ("insufficient access rights on
// cross-reference id"), only by version (MyFlow-3), and versions only exist in the org. A deleted flow is
// therefore deactivated through its FlowDefinition, which always deploys, and reported for manual cleanup.
export class FlowStrategy implements MetadataDeltaStrategy {
  public readonly name = 'flow';
  private readonly typeName = 'Flow';

  private readonly generic = new GenericFileStrategy();

  public supports({ resolvedMetadata, manifestEntry }: ResolvedOperation): boolean {
    return (resolvedMetadata?.typeName ?? manifestEntry?.type) === this.typeName;
  }

  public async build(resolved: ResolvedOperation): Promise<DeltaArtifacts | undefined> {
    const { operation, manifestEntry } = resolved;
    if (operation.kind === 'package' || !manifestEntry) {
      return this.generic.build(resolved);
    }

    const definitionPath = path.posix.join(
      path.posix.dirname(operation.relativePath),
      '..',
      'flowDefinitions',
      `${manifestEntry.fullName}.flowDefinition-meta.xml`
    );

    return {
      dedupeKey: `flow:deactivate:${manifestEntry.fullName}`,
      packageTextFiles: new Map([[definitionPath, inactiveFlowDefinition]]),
      packageManifestEntries: [{ type: 'FlowDefinition', fullName: manifestEntry.fullName }],
      warnings: [
        `Flow:${manifestEntry.fullName} cannot be deleted by name through the Metadata API; it is deactivated instead. Delete its versions manually in the org.`,
      ],
    };
  }
}
