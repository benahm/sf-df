import { registry } from '@salesforce/source-deploy-retrieve';

import { PROFILE_COLLECTION_KEYS } from '../delta/strategies/profile-strategy.js';
import { childCollectionKeys } from '../delta/strategies/registry-child-rules.js';
import { TRANSLATIONS_COLLECTION_KEYS } from '../delta/strategies/translations-strategy.js';

// For each top-level element of a metadata file, the child elements that identify one item. Elements without a
// key (custom, userLicense, label...) are merged as a whole.
export type MergeKeys = Record<string, string[]>;

const PERMISSION_SET_KEYS: MergeKeys = {
  applicationVisibilities: ['application'],
  classAccesses: ['apexClass'],
  customMetadataTypeAccesses: ['name'],
  customPermissions: ['name'],
  customSettingAccesses: ['name'],
  externalCredentialPrincipalAccesses: ['externalCredentialPrincipal'],
  externalDataSourceAccesses: ['externalDataSource'],
  fieldPermissions: ['field'],
  flowAccesses: ['flow'],
  objectPermissions: ['object'],
  pageAccesses: ['apexPage'],
  recordTypeVisibilities: ['recordType'],
  tabSettings: ['tab'],
  userPermissions: ['name'],
};

// Source format splits object translations: field translations live in their own .fieldTranslation-meta.xml.
const OBJECT_TRANSLATION_KEYS: MergeKeys = {
  fieldSets: ['name'],
  layouts: ['layout'],
  quickActions: ['name'],
  recordTypes: ['name'],
  sharingReasons: ['name'],
  standardFields: ['name'],
  validationRules: ['name'],
  webLinks: ['name'],
  workflowTasks: ['name'],
};

// Container types whose children are described in the SDR registry.
const REGISTRY_TYPES = [
  'AssignmentRules',
  'AutoResponseRules',
  'CustomLabels',
  'EscalationRules',
  'MatchingRules',
  'SharingRules',
  'Workflow',
];

const registryKeys = (typeName: string): MergeKeys =>
  Object.fromEntries(Object.entries(childCollectionKeys(typeName)).map(([element, key]) => [element, [key]]));

let keysByRoot: Map<string, MergeKeys> | undefined;

// The root element of a metadata file is its type name (<Profile>, <CustomLabels>...).
const mergeKeysByRoot = (): Map<string, MergeKeys> => {
  keysByRoot ??= new Map<string, MergeKeys>([
    ['Profile', PROFILE_COLLECTION_KEYS],
    ['PermissionSet', PERMISSION_SET_KEYS],
    ['Translations', TRANSLATIONS_COLLECTION_KEYS],
    ['CustomObjectTranslation', OBJECT_TRANSLATION_KEYS],
    ...REGISTRY_TYPES.map((typeName): [string, MergeKeys] => [typeName, registryKeys(typeName)]),
  ]);
  return keysByRoot;
};

export const mergeKeysFor = (rootName: string): MergeKeys | undefined => mergeKeysByRoot().get(rootName);

// .gitattributes patterns of the files handled by the merge driver, from the SDR suffix of each type.
export const mergeDriverPatterns = (): string[] =>
  [...mergeKeysByRoot().keys()]
    .map((typeName) => {
      const suffix = Object.values(registry.types).find((type) => type.name === typeName)?.suffix;
      if (!suffix) {
        throw new Error(`Metadata type ${typeName} has no suffix in the SDR registry.`);
      }

      return `*.${suffix}-meta.xml`;
    })
    .sort();
