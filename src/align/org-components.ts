import type { Connection } from '@salesforce/core';

import {
  listMetadataEntries,
  readMetadataRaw,
  SoapFaultError,
  type ListedComponent,
} from '../retrieve/metadata-read.js';
import { listStandardTabs } from '../retrieve/profile-deployable.js';
import { componentKey, unescapeXml } from '../retrieve/profile-filter.js';

// Not metadata types. The user permissions of the org are the `Permissions*` fields of PermissionSet. Standard
// objects, fields and tabs depend on the features of the org (`Case.Language`): they are read from FieldDefinition
// and TabDefinition. listMetadata lists the standard applications, not the standard tabs.
export const USER_PERMISSION = 'UserPermission';
export const STANDARD_OBJECT = 'StandardObject';
export const STANDARD_FIELD = 'StandardField';
export const STANDARD_TAB = 'StandardTab';

// Keys (see componentKey) of the components of each type in the org. An Error when the type couldn't be read: its
// references are then kept, never removed on a guess.
export type OrgComponents = Map<string, Set<string> | Error>;

const DEFAULT_CONCURRENCY = 5;
// Objects per FieldDefinition query: the IN list stays well below the length limit of a query.
const OBJECTS_PER_QUERY = 50;

// A managed component is named `ns__Name` in some files and `ns.Name` in others (classes, pages): both are known.
export const listedKeys = (type: string, components: ListedComponent[]): Set<string> => {
  const keys = new Set<string>();
  for (const { fullName, namespacePrefix } of components) {
    keys.add(componentKey(type, fullName));
    if (namespacePrefix) {
      const localName = fullName.startsWith(`${namespacePrefix}__`)
        ? fullName.slice(namespacePrefix.length + 2)
        : fullName;
      keys.add(componentKey(type, `${namespacePrefix}__${localName}`));
      keys.add(componentKey(type, `${namespacePrefix}.${localName}`));
    }
  }

  return keys;
};

const userPermissionKeys = async (connection: Connection): Promise<Set<string>> => {
  const { fields } = await connection.describe('PermissionSet');
  return new Set(
    fields
      .map((field) => field.name)
      .filter((name) => name.startsWith('Permissions'))
      .map((name) => componentKey(USER_PERMISSION, name.slice('Permissions'.length)))
  );
};

const standardTabKeys = async (connection: Connection): Promise<Set<string>> =>
  new Set((await listStandardTabs(connection)).map((name) => componentKey(STANDARD_TAB, name)));

type FieldDefinition = { QualifiedApiName: string; EntityDefinition: { QualifiedApiName: string } };

// Fields of the given standard objects, read from the Tooling API: unlike describe, FieldDefinition doesn't depend
// on the field-level security of the user. An object without any field doesn't exist in the org.
const standardFieldKeys = async (
  connection: Connection,
  objects: string[]
): Promise<{ objects: Set<string>; fields: Set<string> }> => {
  const keys = { objects: new Set<string>(), fields: new Set<string>() };
  for (let start = 0; start < objects.length; start += OBJECTS_PER_QUERY) {
    const names = objects
      .slice(start, start + OBJECTS_PER_QUERY)
      .map((name) => `'${name.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`);
    // eslint-disable-next-line no-await-in-loop
    const { records } = await connection.tooling.query<FieldDefinition>(
      'SELECT QualifiedApiName, EntityDefinition.QualifiedApiName FROM FieldDefinition ' +
        `WHERE EntityDefinition.QualifiedApiName IN (${names.join(', ')})`,
      { autoFetch: true, maxFetch: 1_000_000 }
    );
    for (const record of records) {
      const objectName = record.EntityDefinition.QualifiedApiName;
      keys.objects.add(componentKey(STANDARD_OBJECT, objectName));
      keys.fields.add(componentKey(STANDARD_FIELD, `${objectName}.${record.QualifiedApiName}`));
    }
  }

  return keys;
};

// INVALID_TYPE: the org lacks the feature of the type (ServicePresenceStatus without Omni-Channel), so it has none
// of its components.
const isMissingType = (error: unknown): boolean =>
  error instanceof SoapFaultError && error.faultCode.endsWith('INVALID_TYPE');

const readType = async (connection: Connection, type: string): Promise<Set<string> | Error> => {
  try {
    if (type === USER_PERMISSION) {
      return await userPermissionKeys(connection);
    }

    return type === STANDARD_TAB
      ? await standardTabKeys(connection)
      : listedKeys(type, await listMetadataEntries(connection, type));
  } catch (error) {
    if (isMissingType(error)) {
      return new Set();
    }

    return error instanceof Error ? error : new Error(String(error));
  }
};

export type OrgComponentsRequest = {
  // Metadata types, USER_PERMISSION and STANDARD_TAB.
  types: string[];
  // Standard objects whose existence and fields are checked.
  standardObjects: string[];
};

export const listOrgComponents = async (
  connection: Connection,
  request: OrgComponentsRequest,
  concurrency = DEFAULT_CONCURRENCY
): Promise<OrgComponents> => {
  const components: OrgComponents = new Map();
  const standard =
    request.standardObjects.length > 0
      ? standardFieldKeys(connection, request.standardObjects).then(
          ({ objects, fields }) => {
            components.set(STANDARD_OBJECT, objects);
            components.set(STANDARD_FIELD, fields);
          },
          (error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            components.set(STANDARD_OBJECT, failure);
            components.set(STANDARD_FIELD, failure);
          }
        )
      : Promise.resolve();

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < request.types.length) {
      const type = request.types[next++];
      // eslint-disable-next-line no-await-in-loop
      components.set(type, await readType(connection, type));
    }
  };

  await Promise.all([
    standard,
    ...Array.from({ length: Math.max(1, Math.min(concurrency, request.types.length)) }, worker),
  ]);
  return components;
};

const APPLICATION_VISIBILITY = /<applicationVisibilities>([\s\S]*?)<\/applicationVisibilities>/g;

// Default application of a profile in the org, read with the profile. Undefined when the org lacks the profile.
export const defaultApplicationOf = async (connection: Connection, profile: string): Promise<string | undefined> => {
  const [record] = await readMetadataRaw(connection, 'Profile', [profile]);
  for (const [, entry] of record?.body.matchAll(APPLICATION_VISIBILITY) ?? []) {
    const application = /<application>([^<]*)<\/application>/.exec(entry)?.[1];
    if (application !== undefined && entry.includes('<default>true</default>')) {
      return unescapeXml(application);
    }
  }

  return undefined;
};
