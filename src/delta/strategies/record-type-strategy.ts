import { XmlCollectionDeltaStrategy } from './xml-collection-delta-strategy.js';

export class RecordTypeStrategy extends XmlCollectionDeltaStrategy {
  public constructor(sourceDir = 'force-app/main/default') {
    super({
      name: 'recordType',
      matcher: (relativePath) =>
        relativePath.startsWith(`${sourceDir}/objects/`) &&
        /\/recordTypes\/.+\.recordType-meta\.xml$/.test(relativePath),
      rootName: 'RecordType',
      alwaysInclude: ['fullName', 'active', 'label', 'businessProcess', 'compactLayoutAssignment'],
      rules: {},
    });
  }
}
