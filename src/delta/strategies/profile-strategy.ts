import { keyedCollectionRules } from '../xml.js';
import { XmlCollectionDeltaStrategy } from './xml-collection-delta-strategy.js';

// Elements that identify each item of a collection. Salesforce stores many arrays that are semantically sets
// rather than ordered lists; a key made of several elements joins them with "::".
export const PROFILE_COLLECTION_KEYS: Record<string, string[]> = {
  applicationVisibilities: ['application'],
  categoryGroupVisibilities: ['dataCategoryGroup'],
  classAccesses: ['apexClass'],
  customMetadataTypeAccesses: ['name'],
  customPermissions: ['name'],
  customSettingAccesses: ['name'],
  externalDataSourceAccesses: ['externalDataSource'],
  fieldPermissions: ['field'],
  flowAccesses: ['flow'],
  layoutAssignments: ['layout', 'recordType'],
  loginIpRanges: ['startAddress', 'endAddress'],
  objectPermissions: ['object'],
  pageAccesses: ['apexPage'],
  profileActionOverrides: ['actionName'],
  recordTypeVisibilities: ['recordType'],
  tabVisibilities: ['tab'],
  userPermissions: ['name'],
};

export class ProfileStrategy extends XmlCollectionDeltaStrategy {
  public constructor() {
    super({
      name: 'profile',
      metadataTypes: ['Profile'],
      rootName: 'Profile',
      alwaysInclude: ['custom', 'description', 'userLicense'],
      // Verified in a sandbox: deploying a profile, even whole, never revokes an access its XML does not mention.
      warnOnRemovedItems: true,
      rules: keyedCollectionRules(PROFILE_COLLECTION_KEYS),
    });
  }
}
