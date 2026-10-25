import { ComponentSet } from '@salesforce/source-deploy-retrieve';

import { PROFILE_COLLECTION_KEYS } from '../delta/strategies/profile-strategy.js';

// `active`: entries granting nothing are left out, unless the local file already has them. A deployment never revokes
// what the profile doesn't mention (verified in a sandbox): an access revoked in the org must stay in the file, set
// to false. `all`: every entry the org returns.
export type ProfileEntries = 'active' | 'all';
// `org`: accesses to every component of the org. `project`: only to the components of the project and to standard
// ones, so that the profile deploys to an org that lacks the others.
export type ProfileScope = 'org' | 'project';

export type ProfileFilterOptions = {
  entries: ProfileEntries;
  // Keys (`Type:name`, see componentKey) of the project's components. Required by the `project` scope.
  projectComponents?: Set<string>;
};

// An entry is active when one of these flags is true. Sections not listed are always kept: a tab set to Hidden or a
// layout assignment is a choice, not a missing access.
const ACTIVE_FLAGS: Record<string, string[]> = {
  applicationVisibilities: ['default', 'visible'],
  classAccesses: ['enabled'],
  customMetadataTypeAccesses: ['enabled'],
  customPermissions: ['enabled'],
  customSettingAccesses: ['enabled'],
  externalDataSourceAccesses: ['enabled'],
  fieldPermissions: ['editable', 'readable'],
  flowAccesses: ['enabled'],
  objectPermissions: [
    'allowCreate',
    'allowDelete',
    'allowEdit',
    'allowRead',
    'modifyAllRecords',
    'viewAllFields',
    'viewAllRecords',
  ],
  pageAccesses: ['enabled'],
  recordTypeVisibilities: ['default', 'personAccountDefault', 'visible'],
  userPermissions: ['enabled'],
};

export type Reference = { type: string; name: string };

const isCustomName = (name: string): boolean => name.includes('__');

// The object of a field or record type (`Account.Score__c` → `Account`), when it isn't standard.
const customObjectOf = (qualifiedName: string): Reference[] => {
  const objectName = qualifiedName.split('.')[0];
  return isCustomName(objectName) ? [{ type: 'CustomObject', name: objectName }] : [];
};

// Components an entry refers to that may be missing from another org. Standard objects, fields, tabs and
// applications exist everywhere: they are not listed.
export const ACCESS_REFERENCES: Record<string, (value: (child: string) => string | undefined) => Reference[]> = {
  applicationVisibilities: (value) => {
    const name = value('application') ?? '';
    return name.startsWith('standard__') ? [] : [{ type: 'CustomApplication', name }];
  },
  classAccesses: (value) => [{ type: 'ApexClass', name: value('apexClass') ?? '' }],
  customMetadataTypeAccesses: (value) => [{ type: 'CustomObject', name: value('name') ?? '' }],
  customPermissions: (value) => [{ type: 'CustomPermission', name: value('name') ?? '' }],
  customSettingAccesses: (value) => [{ type: 'CustomObject', name: value('name') ?? '' }],
  externalDataSourceAccesses: (value) => [{ type: 'ExternalDataSource', name: value('externalDataSource') ?? '' }],
  fieldPermissions: (value) => {
    const field = value('field') ?? '';
    const fieldName = field.split('.').slice(1).join('.');
    return [...customObjectOf(field), ...(isCustomName(fieldName) ? [{ type: 'CustomField', name: field }] : [])];
  },
  flowAccesses: (value) => [{ type: 'Flow', name: value('flow') ?? '' }],
  layoutAssignments: (value) => {
    const recordType = value('recordType');
    return [
      { type: 'Layout', name: value('layout') ?? '' },
      ...(recordType ? [{ type: 'RecordType', name: recordType }] : []),
    ];
  },
  objectPermissions: (value) => {
    const name = value('object') ?? '';
    return isCustomName(name) ? [{ type: 'CustomObject', name }] : [];
  },
  pageAccesses: (value) => [{ type: 'ApexPage', name: value('apexPage') ?? '' }],
  recordTypeVisibilities: (value) => {
    const name = value('recordType') ?? '';
    return [...customObjectOf(name), { type: 'RecordType', name }];
  },
  tabVisibilities: (value) => {
    const name = value('tab') ?? '';
    return name.startsWith('standard-') ? [] : [{ type: 'CustomTab', name }];
  },
};

export const unescapeXml = (value: string): string =>
  value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

// Files keep encoded names (`Account-Account %28Sales%29 Layout`), profiles may not: both sides are decoded, and
// compared without case as the org does.
export const componentKey = (type: string, name: string): string => {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // A name with a lone % is used as is.
  }

  return `${type}:${decoded}`.toLowerCase();
};

// Keys a reference may be found under. Custom fields of tasks and events belong to Activity, in the org and in the
// project; a person account field (`Account.Score__pc`) is a Contact field, a person account record type
// (`PersonAccount.Retail`) an Account one.
export const referenceKeys = (type: string, name: string): string[] => {
  const keys = [componentKey(type, name)];
  const [objectName, ...rest] = name.split('.');
  const childName = rest.join('.');
  if (type === 'CustomField' && (objectName === 'Task' || objectName === 'Event')) {
    keys.push(componentKey(type, `Activity.${childName}`));
  } else if (type === 'CustomField' && objectName === 'Account' && childName.endsWith('__pc')) {
    keys.push(componentKey(type, `Contact.${childName.slice(0, -'__pc'.length)}__c`));
  } else if (type === 'RecordType' && objectName === 'PersonAccount') {
    keys.push(componentKey(type, `Account.${childName}`));
  }

  return keys;
};

// Every component of the source paths, with its children: fields and record types are files of their own, listed
// without parsing them; labels are entries of their parent's file.
export const projectComponentKeys = (sourcePaths: string[]): Set<string> => {
  const keys = new Set<string>();
  if (sourcePaths.length === 0) {
    return keys;
  }

  for (const component of ComponentSet.fromSource({ fsPaths: sourcePaths }).getSourceComponents()) {
    keys.add(componentKey(component.type.name, component.fullName));
    for (const child of component.getChildren()) {
      keys.add(componentKey(child.type.name, child.fullName));
    }
  }

  return keys;
};

const childValue =
  (element: string) =>
  (child: string): string | undefined => {
    const match = new RegExp(`<${child}>([^<]*)</${child}>`).exec(element);
    return match ? unescapeXml(match[1]) : undefined;
  };

const entryKey = (section: string, element: string): string | undefined => {
  const keyFields = PROFILE_COLLECTION_KEYS[section];
  if (!keyFields) {
    return undefined;
  }

  const value = childValue(element);
  return `${section}:${keyFields.map((field) => value(field) ?? '').join('::')}`;
};

// Keys of the entries of a profile file, whatever its layout.
export const profileEntryKeys = (xml: string): Set<string> => {
  const sections = Object.keys(PROFILE_COLLECTION_KEYS).join('|');
  const keys = new Set<string>();
  for (const match of xml.matchAll(new RegExp(`<(${sections})>([\\s\\S]*?)</\\1>`, 'g'))) {
    const key = entryKey(match[1], match[2]);
    if (key) {
      keys.add(key);
    }
  }

  return keys;
};

// Top-level elements of a file written by formatMetadataFile: a leaf on one line, or a block up to its closing tag
// at the same indentation.
export const splitElements = (xml: string): { head: string[]; elements: Array<{ tag: string; lines: string[] }>; tail: string[] } => {
  const lines = xml.split('\n');
  const head = lines.slice(0, 2);
  const closeIndex = lines.findLastIndex((line) => line.startsWith('</'));
  const tail = lines.slice(closeIndex);
  const elements: Array<{ tag: string; lines: string[] }> = [];
  for (let index = 2; index < closeIndex; ) {
    const line = lines[index];
    const tag = /^ {4}<([\w:-]+)/.exec(line)?.[1] ?? '';
    const end = line.includes(`</${tag}>`) || line.endsWith('/>') ? index : lines.indexOf(`    </${tag}>`, index);
    const last = end === -1 ? index : end;
    elements.push({ tag, lines: lines.slice(index, last + 1) });
    index = last + 1;
  }

  return { head, elements, tail };
};

// Filters a profile written by formatMetadataFile. `localXml` is the file it replaces, if any: with `active`, its
// entries are kept with the org's value, so that an access revoked in the org is written as false.
export const filterProfile = (xml: string, options: ProfileFilterOptions, localXml?: string): string => {
  if (options.entries === 'all' && !options.projectComponents) {
    return xml;
  }

  const localKeys = options.entries === 'active' && localXml ? profileEntryKeys(localXml) : new Set<string>();
  const { head, elements, tail } = splitElements(xml);
  const kept = elements.filter(({ tag, lines }) => {
    const element = lines.join('\n');
    const value = childValue(element);
    if (options.projectComponents) {
      const references = ACCESS_REFERENCES[tag]?.(value) ?? [];
      const inProject = ({ type, name }: Reference): boolean =>
        referenceKeys(type, name).some((key) => options.projectComponents!.has(key));
      if (!references.every(inProject)) {
        return false;
      }
    }

    const flags = ACTIVE_FLAGS[tag];
    if (options.entries === 'all' || !flags || flags.some((flag) => value(flag) === 'true')) {
      return true;
    }

    const key = entryKey(tag, element);
    return key !== undefined && localKeys.has(key);
  });

  return [...head, ...kept.flatMap(({ lines }) => lines), ...tail].join('\n');
};
