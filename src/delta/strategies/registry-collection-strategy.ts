import { childCollectionRules, qualifiesChildNames } from './registry-child-rules.js';
import { XmlCollectionDeltaStrategy } from './xml-collection-delta-strategy.js';

// Partial package/destructive XML for container types whose children are described in the SDR registry
// (SharingRules, AssignmentRules, ...). The XML root element matches the metadata type name.
export class RegistryCollectionStrategy extends XmlCollectionDeltaStrategy {
  public constructor(name: string, typeName: string) {
    super({
      name,
      metadataTypes: [typeName],
      rootName: typeName,
      supportsDestructive: true,
      qualifyChildNames: qualifiesChildNames(typeName),
      rules: childCollectionRules(typeName),
    });
  }
}
