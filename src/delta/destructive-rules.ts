import { registry } from '@salesforce/source-deploy-retrieve';

import type { ManifestEntry } from './types.js';

type RegistryType = (typeof registry)['types'][string];

const childTypeNames = (type: RegistryType | undefined): string[] =>
  Object.values(type?.children?.types ?? {}).map((child) => child.name);

// Components addressed as `Object.Name` that Salesforce deletes together with their object: the object's own
// children plus the per-object containers (workflows, sharing rules, matching rules...).
const OBJECT_SCOPED_TYPES = new Set(
  ['customobject', 'workflow', 'sharingrules', 'matchingrules', 'assignmentrules', 'autoresponserules', 'escalationrules'].flatMap(
    (id) => childTypeNames(registry.types[id])
  )
);

const belongsToObject = (entry: ManifestEntry, objectName: string): boolean =>
  (OBJECT_SCOPED_TYPES.has(entry.type) && entry.fullName.startsWith(`${objectName}.`)) ||
  (entry.type === 'Layout' && entry.fullName.startsWith(`${objectName}-`));

// Verified on a sandbox: listing a deleted object's workflows next to the object makes the deployment fail
// with UNKNOWN_EXCEPTION, while deleting the object alone cascades to all of the above. Quick actions are
// not cascaded (they block the object deletion) and must stay listed.
export const dropComponentsOfDeletedObjects = (entries: ManifestEntry[]): ManifestEntry[] => {
  const deletedObjects = entries.filter((entry) => entry.type === 'CustomObject').map((entry) => entry.fullName);
  return entries.filter((entry) => !deletedObjects.some((objectName) => belongsToObject(entry, objectName)));
};
