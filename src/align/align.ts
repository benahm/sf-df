import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ComponentSet, type SourceComponent } from '@salesforce/source-deploy-retrieve';

import { childElementText, splitTopLevel, type XmlChunks } from '../delta/xml.js';
import {
  ACCESS_REFERENCES,
  projectComponentKeys,
  referenceKeys,
  unescapeXml,
  type Reference,
} from '../retrieve/profile-filter.js';
import {
  STANDARD_FIELD,
  STANDARD_OBJECT,
  STANDARD_TAB,
  USER_PERMISSION,
  type OrgComponents,
  type OrgComponentsRequest,
} from './org-components.js';

// An entry left out of a file, and the component it refers to that the target org lacks.
export type RemovedEntry = { section: string; type: string; name: string };

export type AlignedFile = {
  type: string;
  fullName: string;
  filePath: string;
  // `deleted`: the whole file referred to a missing component (a field translation).
  status: 'changed' | 'deleted';
  removed: RemovedEntry[];
  // The profile's default application was removed: the target org's one is the default instead.
  defaultApplication?: string;
};

// A component that still can't deploy. `missingObject` and `unreadable`: left as is, removing it would remove more
// than an entry. `noDefaultApplication`: its default application was removed and the target org's one is unknown.
export type SkippedComponent = {
  type: string;
  fullName: string;
  filePath: string;
  reason: 'missingObject' | 'unreadable' | 'noDefaultApplication';
};

export type AlignResult = {
  files: AlignedFile[];
  skipped: SkippedComponent[];
  // Types the org couldn't list: their references were kept.
  unlistedTypes: Array<{ type: string; error: string }>;
};

export type AlignOptions = {
  // Files or folders to align.
  sourcePaths: string[];
  // Components deployed with them, the project's package directories: a reference to one of them is kept.
  projectPaths: string[];
  listOrgComponents: (request: OrgComponentsRequest) => Promise<OrgComponents>;
  // Default application of a profile in the target org, undefined when the org lacks the profile.
  defaultApplication?: (profile: string) => Promise<string | undefined>;
  dryRun?: boolean;
};

type Value = (child: string) => string | undefined;
type EntryReferences = (tag: string, raw: string, fullName: string) => Reference[];
type FileRules = {
  // Types listed in the org to check the references of the file.
  types: string[];
  entry: EntryReferences;
};

const childValue =
  (raw: string): Value =>
  (child) => {
    const text = childElementText(raw, child);
    return text === undefined ? undefined : unescapeXml(text);
  };

const leafValue = (raw: string): string => unescapeXml(raw.slice(raw.indexOf('>') + 1, raw.lastIndexOf('<')));

const isCustomName = (name: string): boolean => name.includes('__');

// Standard objects and fields too: some depend on a feature the target org may lack (`Case.Language`).
const standardReferences = (objectName: string, fieldName?: string): Reference[] => {
  if (isCustomName(objectName)) {
    return [];
  }

  const object = { type: STANDARD_OBJECT, name: objectName };
  return fieldName === undefined || isCustomName(fieldName)
    ? [object]
    : [object, { type: STANDARD_FIELD, name: `${objectName}.${fieldName}` }];
};

// Standard applications and tabs depend on the features of the org too (`standard__AgentforceStudio`, verified on a
// scratch org; `standard-AccountAccountRelation` is refused by the very org that returns it in a profile).
const applicationReferences = (name: string): Reference[] => [{ type: 'CustomApplication', name }];
const tabReferences = (name: string): Reference[] => [
  { type: name.startsWith('standard-') ? STANDARD_TAB : 'CustomTab', name },
];

const PERMISSION_REFERENCES: Record<string, (value: Value) => Reference[]> = {
  ...ACCESS_REFERENCES,
  applicationVisibilities: (value) => applicationReferences(value('application') ?? ''),
  fieldPermissions: (value) => {
    const [objectName, ...fieldName] = (value('field') ?? '').split('.');
    return [...ACCESS_REFERENCES.fieldPermissions(value), ...standardReferences(objectName, fieldName.join('.'))];
  },
  objectPermissions: (value) => [
    ...ACCESS_REFERENCES.objectPermissions(value),
    ...standardReferences(value('object') ?? ''),
  ],
  // Verified on a scratch org without Omni-Channel: the whole profile is refused.
  servicePresenceStatusAccesses: (value) => [
    { type: 'ServicePresenceStatus', name: value('servicePresenceStatus') ?? '' },
  ],
  tabSettings: (value) => tabReferences(value('tab') ?? ''),
  tabVisibilities: (value) => tabReferences(value('tab') ?? ''),
  userPermissions: (value) => [{ type: USER_PERMISSION, name: value('name') ?? '' }],
};

const PERMISSION_RULES: FileRules = {
  types: [
    'ApexClass',
    'ApexPage',
    'CustomApplication',
    'CustomField',
    'CustomObject',
    'CustomPermission',
    'CustomTab',
    'ExternalDataSource',
    'Flow',
    'Layout',
    'RecordType',
    'ServicePresenceStatus',
    STANDARD_TAB,
    USER_PERMISSION,
  ],
  entry: (tag, raw) => PERMISSION_REFERENCES[tag]?.(childValue(raw)) ?? [],
};

const PERMISSION_SET_GROUP_ELEMENTS: Record<string, string> = {
  mutingPermissionSets: 'MutingPermissionSet',
  permissionSets: 'PermissionSet',
};

// The org lists the standard quick actions (`LogACall`).
const TRANSLATION_REFERENCES: Record<string, (value: Value) => Reference[]> = {
  customApplications: (value) => applicationReferences(value('name') ?? ''),
  customLabels: (value) => [{ type: 'CustomLabel', name: value('name') ?? '' }],
  customTabs: (value) => tabReferences(value('name') ?? ''),
  flowDefinitions: (value) => [{ type: 'Flow', name: value('fullName') ?? value('name') ?? '' }],
  quickActions: (value) => [{ type: 'QuickAction', name: value('name') ?? '' }],
  reportTypes: (value) => [{ type: 'ReportType', name: value('name') ?? '' }],
};

// `Account-fr` translates Account.
const objectOfTranslation = (fullName: string): string => fullName.slice(0, fullName.lastIndexOf('-'));

// The org lists the standard quick actions and web links too (`Case.LogACall`, `Campaign.ViewCampaignInfluenceReport`).
const OBJECT_TRANSLATION_REFERENCES: Record<string, (value: Value, objectName: string) => Reference[]> = {
  fieldSets: (value, objectName) => [{ type: 'FieldSet', name: `${objectName}.${value('name') ?? ''}` }],
  layouts: (value, objectName) => [{ type: 'Layout', name: `${objectName}-${value('layout') ?? ''}` }],
  quickActions: (value, objectName) => [{ type: 'QuickAction', name: `${objectName}.${value('name') ?? ''}` }],
  recordTypes: (value, objectName) => [{ type: 'RecordType', name: `${objectName}.${value('name') ?? ''}` }],
  validationRules: (value, objectName) => [
    { type: 'ValidationRule', name: `${objectName}.${value('name') ?? ''}` },
  ],
  webLinks: (value, objectName) => [{ type: 'WebLink', name: `${objectName}.${value('name') ?? ''}` }],
};

const RULES: Record<string, FileRules> = {
  Profile: PERMISSION_RULES,
  PermissionSet: PERMISSION_RULES,
  MutingPermissionSet: PERMISSION_RULES,
  PermissionSetGroup: {
    types: Object.values(PERMISSION_SET_GROUP_ELEMENTS),
    entry: (tag, raw) => {
      const type = PERMISSION_SET_GROUP_ELEMENTS[tag];
      return type ? [{ type, name: leafValue(raw) }] : [];
    },
  },
  Translations: {
    types: ['CustomApplication', 'CustomLabel', 'CustomTab', 'Flow', 'QuickAction', 'ReportType', STANDARD_TAB],
    entry: (tag, raw) => TRANSLATION_REFERENCES[tag]?.(childValue(raw)) ?? [],
  },
  CustomObjectTranslation: {
    types: [
      'CustomField',
      'CustomObject',
      'FieldSet',
      'Layout',
      'QuickAction',
      'RecordType',
      'ValidationRule',
      'WebLink',
    ],
    entry: (tag, raw, fullName) =>
      OBJECT_TRANSLATION_REFERENCES[tag]?.(childValue(raw), objectOfTranslation(fullName)) ?? [],
  },
};

export const ALIGNED_TYPES = Object.keys(RULES);

const PERMISSION_TYPES = new Set(['Profile', 'PermissionSet', 'MutingPermissionSet']);
const OBJECT_OF_ENTRY = /<field>([^<.]+)\.[^<]*<\/field>|<object>([^<]+)<\/object>/g;

// Standard objects named by the field and object accesses: FieldDefinition is only read for them.
const standardObjectsOf = async (components: SourceComponent[]): Promise<string[]> => {
  const objects = new Set<string>();
  for (const component of components) {
    if (PERMISSION_TYPES.has(component.type.name) && component.xml) {
      // eslint-disable-next-line no-await-in-loop
      for (const match of (await readFile(component.xml, 'utf8')).matchAll(OBJECT_OF_ENTRY)) {
        const objectName = unescapeXml(match[1] ?? match[2]);
        if (!isCustomName(objectName)) {
          objects.add(objectName);
        }
      }
    }
  }

  return [...objects].sort();
};

type IsKnown = (reference: Reference) => boolean;

type AlignContext = {
  isKnown: IsKnown;
  dryRun: boolean;
  defaultApplication?: (profile: string) => Promise<string | undefined>;
};

const DEFAULT_APPLICATION = '<default>true</default>';

const joinChunks = (chunks: XmlChunks): string =>
  chunks.prolog +
  chunks.rootOpen +
  chunks.items.map((item) => item.lead + item.raw).join('') +
  chunks.tail +
  chunks.rootClose;

// Rewrites the file without the entries referring to a missing component. Everything else is kept byte for byte.
const alignXml = (
  xml: string,
  fullName: string,
  entry: EntryReferences,
  isKnown: IsKnown
): { xml: string; removed: RemovedEntry[]; lostDefaultApplication: boolean } | undefined => {
  const chunks = splitTopLevel(xml);
  if (!chunks) {
    return undefined;
  }

  const removed: RemovedEntry[] = [];
  let removedDefaultApplication = false;
  let keptDefaultApplication = false;
  let body = '';
  for (const item of chunks.items) {
    // Record type visibilities have a <default> element too: only applications are looked at.
    const isDefaultApplication = item.tag === 'applicationVisibilities' && item.raw.includes(DEFAULT_APPLICATION);
    const missing = entry(item.tag, item.raw, fullName).find((reference) => !isKnown(reference));
    if (missing) {
      removed.push({ section: item.tag, type: missing.type, name: missing.name });
      removedDefaultApplication ||= isDefaultApplication;
      // A comment before the entry may be about the next ones: it stays, only the indentation goes.
      const commentEnd = item.lead.lastIndexOf('-->');
      body += commentEnd === -1 ? '' : item.lead.slice(0, commentEnd + '-->'.length);
    } else {
      keptDefaultApplication ||= isDefaultApplication;
      body += item.lead + item.raw;
    }
  }

  return {
    xml: chunks.prolog + chunks.rootOpen + body + chunks.tail + chunks.rootClose,
    removed,
    lostDefaultApplication: removedDefaultApplication && !keptDefaultApplication,
  };
};

const escapeXml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Makes `application` the default one of a profile left without default. Verified on a scratch org: a profile
// without a default application is refused (`You can't remove the only default app from the profile`), also when
// the remaining entries have no <default> element.
export const setDefaultApplication = (xml: string, application: string): string => {
  const chunks = splitTopLevel(xml)!;
  const { items } = chunks;
  const existing = items.find(
    (item) =>
      item.tag === 'applicationVisibilities' &&
      unescapeXml(childElementText(item.raw, 'application') ?? '') === application
  );
  if (existing) {
    existing.raw = existing.raw.replace('<default>false</default>', DEFAULT_APPLICATION);
    return joinChunks(chunks);
  }

  // A new entry, where the retrieve sorts it, indented like its neighbours.
  const index = items.findIndex((item) => item.tag > 'applicationVisibilities');
  const position = index === -1 ? items.length : index;
  const lead = items[position]?.lead ?? items.at(-1)?.lead ?? '\n    ';
  const newline = xml.includes('\r\n') ? '\r\n' : '\n';
  const indent = lead.slice(lead.lastIndexOf('\n') + 1);
  const child = `${newline}${indent}    `;
  const raw =
    `<applicationVisibilities>${child}<application>${escapeXml(application)}</application>` +
    `${child}${DEFAULT_APPLICATION}${child}<visible>true</visible>${newline}${indent}</applicationVisibilities>`;
  items.splice(position, 0, { tag: 'applicationVisibilities', raw, lead });
  return joinChunks(chunks);
};

type ComponentAlignment = { files: AlignedFile[]; skipped: SkippedComponent[] };

const alignFile = async (
  component: SourceComponent,
  filePath: string,
  entry: EntryReferences,
  context: AlignContext
): Promise<ComponentAlignment> => {
  const { name: type } = component.type;
  const aligned = alignXml(await readFile(filePath, 'utf8'), component.fullName, entry, context.isKnown);
  if (!aligned) {
    return { files: [], skipped: [{ type, fullName: component.fullName, filePath, reason: 'unreadable' }] };
  }

  if (aligned.removed.length === 0) {
    return { files: [], skipped: [] };
  }

  const file: AlignedFile = { type, fullName: component.fullName, filePath, status: 'changed', removed: aligned.removed };
  const skipped: SkippedComponent[] = [];
  let xml = aligned.xml;
  if (type === 'Profile' && aligned.lostDefaultApplication) {
    const application = await context.defaultApplication?.(component.fullName).catch(() => undefined);
    if (application) {
      xml = setDefaultApplication(xml, application);
      file.defaultApplication = application;
    } else {
      skipped.push({ type, fullName: component.fullName, filePath, reason: 'noDefaultApplication' });
    }
  }

  if (!context.dryRun) {
    await writeFile(filePath, xml, 'utf8');
  }

  return { files: [file], skipped };
};

// Source format splits an object translation: the object's file, and one file per field translation.
const alignObjectTranslation = async (component: SourceComponent, context: AlignContext): Promise<ComponentAlignment> => {
  const { isKnown, dryRun } = context;
  const objectName = objectOfTranslation(component.fullName);
  if (isCustomName(objectName) && !isKnown({ type: 'CustomObject', name: objectName })) {
    // The whole translation would go: left to the user, as a translation is never deleted on a guess.
    return {
      files: [],
      skipped: [
        {
          type: component.type.name,
          fullName: component.fullName,
          filePath: component.xml ?? component.content ?? '',
          reason: 'missingObject',
        },
      ],
    };
  }

  const result: ComponentAlignment = component.xml
    ? await alignFile(component, component.xml, RULES.CustomObjectTranslation.entry, context)
    : { files: [], skipped: [] };

  for (const child of component.getChildren()) {
    const fieldName = path.basename(child.xml ?? '').replace(/\.fieldTranslation-meta\.xml$/, '');
    const field = { type: 'CustomField', name: `${objectName}.${fieldName}` };
    if (child.xml && isCustomName(fieldName) && !isKnown(field)) {
      if (!dryRun) {
        // eslint-disable-next-line no-await-in-loop
        await rm(child.xml);
      }

      result.files.push({
        type: child.type.name,
        fullName: child.fullName,
        filePath: child.xml,
        status: 'deleted',
        removed: [{ section: child.type.name, ...field }],
      });
    }
  }

  return result;
};

// Removes, from the permission and translation files of the source paths, the entries referring to components that
// neither the target org nor the project has: deploying them would fail.
export const alignFiles = async (options: AlignOptions): Promise<AlignResult> => {
  const components = ComponentSet.fromSource({ fsPaths: options.sourcePaths })
    .getSourceComponents()
    .toArray()
    .filter((component) => RULES[component.type.name] !== undefined);
  if (components.length === 0) {
    return { files: [], skipped: [], unlistedTypes: [] };
  }

  const types = [...new Set(components.flatMap((component) => RULES[component.type.name].types))].sort();
  const org = await options.listOrgComponents({ types, standardObjects: await standardObjectsOf(components) });
  const project = projectComponentKeys(options.projectPaths);
  const isKnown: IsKnown = ({ type, name }) => {
    if (name === '') {
      return true;
    }

    const keys = referenceKeys(type, name);
    if (keys.some((key) => project.has(key))) {
      return true;
    }

    const listed = org.get(type);
    return listed === undefined || listed instanceof Error || keys.some((key) => listed.has(key));
  };

  const result: AlignResult = {
    files: [],
    skipped: [],
    unlistedTypes: [...org]
      .filter((entry): entry is [string, Error] => entry[1] instanceof Error)
      .map(([type, error]) => ({ type, error: error.message })),
  };
  const context: AlignContext = {
    isKnown,
    dryRun: options.dryRun ?? false,
    defaultApplication: options.defaultApplication,
  };
  for (const component of components) {
    // One file at a time: profiles can weigh megabytes each.
    // eslint-disable-next-line no-await-in-loop
    const aligned = await (component.type.name === 'CustomObjectTranslation'
      ? alignObjectTranslation(component, context)
      : component.xml
        ? alignFile(component, component.xml, RULES[component.type.name].entry, context)
        : { files: [], skipped: [] });
    result.files.push(...aligned.files);
    result.skipped.push(...aligned.skipped);
  }

  return result;
};
