import { XmlCollectionDeltaStrategy } from './xml-collection-delta-strategy.js';

export class RecordTypeStrategy extends XmlCollectionDeltaStrategy {
  public constructor() {
    super({
      name: 'recordType',
      metadataTypes: ['RecordType'],
      rootName: 'RecordType',
      alwaysInclude: ['fullName', 'active', 'label', 'businessProcess', 'compactLayoutAssignment'],
      rules: {},
      // Verified on a sandbox: destructiveChanges fails with "Cannot delete record type through API".
      deactivateOnDelete: { fieldName: 'active', value: 'false' },
    });
  }
}
