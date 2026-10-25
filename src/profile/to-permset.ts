import { splitTopLevel, type XmlChunk } from '../delta/xml.js';

export type ToPermsetOptions = {
  // Profile file content, in any layout.
  profileXml: string;
  // API name and label of the permission set.
  name: string;
  label: string;
  description?: string;
  // Leaves the profile as it is: the permission set is only a copy of its accesses.
  keepProfile?: boolean;
};

export type ToPermsetResult = {
  permissionSetXml: string;
  // Undefined when the profile is left as it is.
  profileXml?: string;
  // Entries copied to the permission set, per section of the profile.
  moved: Record<string, number>;
  // A standard profile can't lose its user and object permissions: it is left as it is.
  standardProfile: boolean;
};

type Child = { name: string; value: string };

// Children of a flat entry (`<classAccesses><apexClass>Foo</apexClass><enabled>true</enabled></classAccesses>`).
const childrenOf = (raw: string): Child[] =>
  [...raw.matchAll(/<(\w+)>([^<]*)<\/\1>/g)].map((match) => ({ name: match[1], value: match[2] }));

const isTrue = (children: Child[], ...names: string[]): boolean =>
  children.some((child) => names.includes(child.name) && child.value === 'true');

type Section = {
  // Whether the entry grants something: entries that grant nothing are not copied.
  isActive: (children: Child[]) => boolean;
  // Element of the permission set. Default: the same element.
  toPermissionSet?: (children: Child[]) => { tag: string; children: Child[] };
  // Entry left on the profile, revoked. Undefined: the profile keeps it as it is (its default application or
  // record type must stay visible on the profile).
  revoke: (raw: string, children: Child[]) => string | undefined;
};

const setFalse =
  (...names: string[]) =>
  (raw: string): string =>
    names.reduce((xml, name) => xml.replace(`<${name}>true</${name}>`, `<${name}>false</${name}>`), raw);

const enabledSection: Section = {
  isActive: (children) => isTrue(children, 'enabled'),
  revoke: setFalse('enabled'),
};

const OBJECT_FLAGS = [
  'allowCreate',
  'allowDelete',
  'allowEdit',
  'allowRead',
  'modifyAllRecords',
  'viewAllFields',
  'viewAllRecords',
];

// A permission set has no default application or record type, and Visible / Available tab settings where a profile
// has DefaultOn / DefaultOff.
const TAB_SETTINGS: Record<string, string> = { DefaultOn: 'Visible', DefaultOff: 'Available' };

const SECTIONS: Record<string, Section> = {
  applicationVisibilities: {
    isActive: (children) => isTrue(children, 'visible'),
    toPermissionSet: (children) => ({
      tag: 'applicationVisibilities',
      children: children.filter((child) => child.name !== 'default'),
    }),
    revoke: (raw, children) => (isTrue(children, 'default') ? undefined : setFalse('visible')(raw)),
  },
  classAccesses: enabledSection,
  customMetadataTypeAccesses: enabledSection,
  customPermissions: enabledSection,
  customSettingAccesses: enabledSection,
  externalDataSourceAccesses: enabledSection,
  fieldPermissions: {
    isActive: (children) => isTrue(children, 'editable', 'readable'),
    revoke: setFalse('editable', 'readable'),
  },
  flowAccesses: enabledSection,
  objectPermissions: {
    isActive: (children) => isTrue(children, ...OBJECT_FLAGS),
    revoke: setFalse(...OBJECT_FLAGS),
  },
  pageAccesses: enabledSection,
  recordTypeVisibilities: {
    isActive: (children) => isTrue(children, 'visible'),
    toPermissionSet: (children) => ({
      tag: 'recordTypeVisibilities',
      children: children.filter((child) => child.name === 'recordType' || child.name === 'visible'),
    }),
    revoke: (raw, children) =>
      isTrue(children, 'default', 'personAccountDefault') ? undefined : setFalse('visible')(raw),
  },
  tabVisibilities: {
    isActive: (children) => children.some((child) => child.name === 'visibility' && child.value in TAB_SETTINGS),
    toPermissionSet: (children) => ({
      tag: 'tabSettings',
      children: children.map((child) =>
        child.name === 'visibility' ? { name: 'visibility', value: TAB_SETTINGS[child.value] } : child
      ),
    }),
    revoke: (raw) => raw.replace(/<visibility>Default(On|Off)<\/visibility>/, '<visibility>Hidden</visibility>'),
  },
  userPermissions: enabledSection,
};

// Sections a standard profile can't change: its user and object permissions are fixed by Salesforce.
const FIXED_ON_STANDARD_PROFILES = new Set(['objectPermissions', 'userPermissions']);

const escapeXml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const leaf = (name: string, value: string): string => `    <${name}>${value}</${name}>`;

const entry = (tag: string, children: Child[]): string =>
  [`    <${tag}>`, ...children.map((child) => `    ${leaf(child.name, child.value)}`), `    </${tag}>`].join('\n');

const permissionSetXml = (options: ToPermsetOptions, entries: Array<{ tag: string; xml: string }>): string => {
  const elements = [
    ...entries,
    ...(options.description ? [{ tag: 'description', xml: leaf('description', escapeXml(options.description)) }] : []),
    { tag: 'hasActivationRequired', xml: leaf('hasActivationRequired', 'false') },
    { tag: 'label', xml: leaf('label', escapeXml(options.label)) },
  ];
  // The order of a retrieved permission set: elements sorted by name, entries in the profile's order (stable sort).
  elements.sort((left, right) => (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...elements.map((element) => element.xml),
    '</PermissionSet>',
    '',
  ].join('\n');
};

// Copies the accesses of a profile to a permission set and revokes them on the profile. A deployment never revokes
// an access the profile doesn't mention: the profile keeps each moved entry, set to false.
export const profileToPermissionSet = (options: ToPermsetOptions): ToPermsetResult => {
  const chunks = splitTopLevel(options.profileXml);
  if (!chunks) {
    throw new Error('The profile is not a metadata file.');
  }

  const standardProfile = chunks.items.some((item) => item.tag === 'custom' && /^<custom>\s*false\s*</.test(item.raw));
  const entries: Array<{ tag: string; xml: string }> = [];
  const moved: Record<string, number> = {};
  const profileItems: XmlChunk[] = [];
  let profileChanged = false;
  for (const item of chunks.items) {
    const section = SECTIONS[item.tag];
    const children = section ? childrenOf(item.raw) : [];
    if (!section?.isActive(children)) {
      profileItems.push(item);
      continue;
    }

    const element = section.toPermissionSet?.(children) ?? { tag: item.tag, children };
    entries.push({ tag: element.tag, xml: entry(element.tag, element.children) });
    moved[item.tag] = (moved[item.tag] ?? 0) + 1;

    const revoked =
      options.keepProfile || (standardProfile && FIXED_ON_STANDARD_PROFILES.has(item.tag))
        ? undefined
        : section.revoke(item.raw, children);
    profileChanged ||= revoked !== undefined && revoked !== item.raw;
    profileItems.push(revoked === undefined ? item : { ...item, raw: revoked });
  }

  return {
    permissionSetXml: permissionSetXml(options, entries),
    ...(profileChanged
      ? {
          profileXml:
            chunks.prolog +
            chunks.rootOpen +
            profileItems.map((item) => item.lead + item.raw).join('') +
            chunks.tail +
            chunks.rootClose,
        }
      : {}),
    moved,
    standardProfile,
  };
};

// API name of a permission set: letters, digits and single underscores, starting with a letter, 80 characters.
export const permissionSetNameOf = (profileName: string): string => {
  const name = profileName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const prefixed = /^[A-Za-z]/.test(name) ? name : `P_${name}`;
  return prefixed.slice(0, 80).replace(/_+$/, '');
};
