import { textOf, type XmlKeyRule } from '../xml.js';
import { XmlCollectionDeltaStrategy } from './xml-collection-delta-strategy.js';

const keyedBy = (fieldName: string): XmlKeyRule => ({
  keySelector: (item: Record<string, unknown>) => textOf(item[fieldName]),
});

const layoutKey = (item: Record<string, unknown>): string =>
  `${textOf(item.layout)}::${textOf(item.recordType)}`;

// Profiles need stable keys per collection because Salesforce stores many arrays
// that are semantically sets rather than ordered lists.
export class ProfileStrategy extends XmlCollectionDeltaStrategy {
  public constructor() {
    super({
      name: 'profile',
      metadataTypes: ['Profile'],
      rootName: 'Profile',
      alwaysInclude: ['custom', 'description', 'userLicense'],
      rules: {
        applicationVisibilities: keyedBy('application'),
        categoryGroupVisibilities: keyedBy('dataCategoryGroup'),
        classAccesses: keyedBy('apexClass'),
        customMetadataTypeAccesses: keyedBy('name'),
        customPermissions: keyedBy('name'),
        customSettingAccesses: keyedBy('name'),
        externalDataSourceAccesses: keyedBy('externalDataSource'),
        fieldPermissions: keyedBy('field'),
        flowAccesses: keyedBy('flow'),
        layoutAssignments: { keySelector: layoutKey },
        loginIpRanges: {
          keySelector: (item) => `${textOf(item.startAddress)}::${textOf(item.endAddress)}`,
        },
        objectPermissions: keyedBy('object'),
        pageAccesses: keyedBy('apexPage'),
        profileActionOverrides: keyedBy('actionName'),
        recordTypeVisibilities: keyedBy('recordType'),
        tabVisibilities: keyedBy('tab'),
        userPermissions: keyedBy('name'),
      },
    });
  }
}
