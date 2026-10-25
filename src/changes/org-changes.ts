import type { FileProperties, MetadataTypeInfo } from '../retrieve/metadata-read.js';
import { componentKey } from '../retrieve/profile-filter.js';

// Where a change was found. `metadata`: the date and author listMetadata returns. `tracking`: SourceMember, the only
// source of deletions. `accesses`: the permission rows of a profile or permission set, the only trace of an access
// changed in Setup (verified on a scratch org: it moves neither the listMetadata date nor SourceMember).
export type ChangeSource = 'metadata' | 'tracking' | 'accesses';

export type OrgChange = {
  type: string;
  fullName: string;
  // ISO date, UTC.
  lastModifiedDate: string;
  // Unknown for `accesses`: the permission rows have no author.
  lastModifiedById?: string;
  lastModifiedByName?: string;
  status: 'changed' | 'deleted';
  source: ChangeSource;
};

export type TrackedChange = {
  type: string;
  fullName: string;
  lastModifiedDate: string;
  lastModifiedById?: string;
  lastModifiedByName?: string;
  deleted: boolean;
};

// The newest change of the permission rows of a profile (profileId) or of a permission set (permissionSetId).
export type AccessChange = { profileId?: string; permissionSetId?: string; lastModifiedDate: string };

export type ChangeQuery = {
  since?: Date;
  // Newest changes kept. Undefined: all.
  limit?: number;
  // Ids of the authors kept. Undefined: every author but Automated Process.
  users?: string[];
};

export type OrgChangesSources = {
  describeTypes: () => Promise<MetadataTypeInfo[]>;
  // Ids of the Automated Process users: the platform's recalculations (permission set groups...).
  automatedUsers: () => Promise<string[]>;
  listComponents: (
    types: MetadataTypeInfo[]
  ) => Promise<{ components: FileProperties[]; unlisted: Array<{ type: string; error: string }> }>;
  // Undefined when the org has no source tracking.
  trackedChanges: (
    query: ChangeQuery & { types: string[]; excludedUsers: string[] }
  ) => Promise<TrackedChange[] | undefined>;
  accessChanges: (
    holders: { profileIds: string[]; permissionSetIds: string[] },
    query: ChangeQuery
  ) => Promise<AccessChange[]>;
};

export type OrgChangesOptions = ChangeQuery & {
  sources: OrgChangesSources;
  // Types to list. Undefined: every type of the org but those stored in folders (reports, dashboards...).
  types?: string[];
  // Full names of the project's profiles and permission sets: changes of their accesses are listed. Undefined: not
  // looked for. Creating a tab adds a row to every profile of the org: outside the project, they would bury the rest.
  accessHolders?: { profiles: string[]; permissionSets: string[] };
};

export type OrgChangesResult = {
  changes: OrgChange[];
  // Whether the org has source tracking: without it, deleted components can't be listed.
  tracking: boolean;
  // Types the org couldn't list.
  unlistedTypes: Array<{ type: string; error: string }>;
};

export class UnknownTypesError extends Error {
  public constructor(public readonly types: string[]) {
    super(`Unknown metadata types: ${types.join(', ')}`);
    this.name = 'UnknownTypesError';
  }
}

// Read from source tracking only, when the org has it: listMetadata takes 30 s for the 30,000 fields of a large org
// (measured in a sandbox), and tracking records the fields created in Setup and deployed alike, deletions included.
const TRACKED_TYPES = new Set(['CustomField']);

// Ids compared on their first 15 characters: the APIs don't all return the same length.
const idKey = (id: string | undefined): string => (id ?? '').slice(0, 15);

// Components of installed packages: they change with the package, not in the org.
const INSTALLED_STATES = new Set(['installed', 'installedEditable', 'deprecated', 'deprecatedEditable']);

const isDated = (date: string | undefined): date is string => date !== undefined && !date.startsWith('1970-');

const isoDate = (date: string): string => new Date(date).toISOString();

const selectTypes = (orgTypes: MetadataTypeInfo[], requested: string[] | undefined): MetadataTypeInfo[] => {
  if (!requested) {
    return orgTypes.filter((type) => !type.inFolder);
  }

  const byName = new Map(orgTypes.map((type) => [type.name.toLowerCase(), type]));
  const unknown = requested.filter((name) => !byName.has(name.toLowerCase()));
  if (unknown.length > 0) {
    throw new UnknownTypesError(unknown);
  }

  return [...new Map(requested.map((name) => [name.toLowerCase(), byName.get(name.toLowerCase())!])).values()];
};

const queryOf = ({ since, limit, users }: ChangeQuery): ChangeQuery => ({ since, limit, users });

const idsOf = (components: FileProperties[], type: string, names?: string[]): Map<string, string> => {
  const wanted = names ? new Set(names.map((name) => componentKey(type, name))) : undefined;
  const ids = new Map<string, string>();
  for (const component of components) {
    if (component.type === type && component.id && (!wanted || wanted.has(componentKey(type, component.fullName)))) {
      ids.set(idKey(component.id), component.fullName);
    }
  }

  return ids;
};

const accessRows = async (
  options: OrgChangesOptions,
  selected: MetadataTypeInfo[],
  components: FileProperties[]
): Promise<OrgChange[]> => {
  const holders = options.accessHolders;
  const listed = new Set(selected.map((type) => type.name));
  if (!holders) {
    return [];
  }

  const profiles = listed.has('Profile') ? idsOf(components, 'Profile', holders.profiles) : new Map<string, string>();
  const permissionSets = listed.has('PermissionSet')
    ? idsOf(components, 'PermissionSet', holders.permissionSets)
    : new Map<string, string>();
  if (profiles.size === 0 && permissionSets.size === 0) {
    return [];
  }

  const changes = await options.sources.accessChanges(
    { profileIds: [...profiles.keys()], permissionSetIds: [...permissionSets.keys()] },
    queryOf(options)
  );
  return changes.flatMap((change): OrgChange[] => {
    const [type, fullName] = change.profileId
      ? ['Profile', profiles.get(idKey(change.profileId))]
      : ['PermissionSet', permissionSets.get(idKey(change.permissionSetId))];
    return fullName === undefined
      ? []
      : [{ type, fullName, lastModifiedDate: isoDate(change.lastModifiedDate), status: 'changed', source: 'accesses' }];
  });
};

// The changes of the org, newest first. Every component listMetadata dates, but the custom fields when source
// tracking records them; the changes source tracking records, deletions included; the access changes of the
// project's profiles and permission sets. One line per component, its newest change.
export const listOrgChanges = async (options: OrgChangesOptions): Promise<OrgChangesResult> => {
  const [orgTypes, automated] = await Promise.all([
    options.sources.describeTypes(),
    options.users ? Promise.resolve([]) : options.sources.automatedUsers(),
  ]);
  const selected = selectTypes(orgTypes, options.types);
  const selectedNames = new Set(selected.map((type) => type.name));
  const tracked = await options.sources.trackedChanges({
    ...queryOf(options),
    types: [...selectedNames],
    excludedUsers: automated,
  });
  const { components, unlisted } = await options.sources.listComponents(
    tracked ? selected.filter((type) => !TRACKED_TYPES.has(type.name)) : selected
  );
  const accesses = await accessRows(options, selected, components);

  const listedKeys = new Set(components.map((component) => componentKey(component.type, component.fullName)));
  const installedKeys = new Set(
    components
      .filter((component) => INSTALLED_STATES.has(component.manageableState ?? ''))
      .map((component) => componentKey(component.type, component.fullName))
  );
  const rows: OrgChange[] = [
    ...components
      .filter((component) => isDated(component.lastModifiedDate))
      .map(
        (component): OrgChange => ({
          type: component.type,
          fullName: component.fullName,
          lastModifiedDate: isoDate(component.lastModifiedDate!),
          lastModifiedById: component.lastModifiedById,
          lastModifiedByName: component.lastModifiedByName,
          status: 'changed',
          source: 'metadata',
        })
      ),
    // Source tracking also records parts of components that are no metadata type (LightningComponentResource).
    ...(tracked ?? [])
      .filter((change) => selectedNames.has(change.type))
      .map(
        (change): OrgChange => ({
          type: change.type,
          fullName: change.fullName,
          lastModifiedDate: isoDate(change.lastModifiedDate),
          lastModifiedById: change.lastModifiedById,
          lastModifiedByName: change.lastModifiedByName,
          // A component listMetadata still lists exists: it was deleted, then created again.
          status: change.deleted && !listedKeys.has(componentKey(change.type, change.fullName)) ? 'deleted' : 'changed',
          source: 'tracking',
        })
      ),
    ...accesses,
  ];

  const users = options.users ? new Set(options.users.map(idKey)) : undefined;
  const excluded = new Set(automated.map(idKey));
  const since = options.since?.getTime();
  const kept = rows.filter(
    (row) =>
      !installedKeys.has(componentKey(row.type, row.fullName)) &&
      (since === undefined || Date.parse(row.lastModifiedDate) >= since) &&
      // An access change has no author: it is kept whatever the author asked.
      (row.source === 'accesses' ||
        (users ? users.has(idKey(row.lastModifiedById)) : !excluded.has(idKey(row.lastModifiedById))))
  );

  // One line per component: its newest change.
  const newest = new Map<string, OrgChange>();
  for (const row of kept) {
    const key = componentKey(row.type, row.fullName);
    const current = newest.get(key);
    if (!current || row.lastModifiedDate > current.lastModifiedDate) {
      newest.set(key, row);
    }
  }

  const changes = [...newest.values()].sort(
    (left, right) =>
      right.lastModifiedDate.localeCompare(left.lastModifiedDate) ||
      left.type.localeCompare(right.type) ||
      left.fullName.localeCompare(right.fullName)
  );
  return {
    changes: options.limit === undefined ? changes : changes.slice(0, options.limit),
    tracking: tracked !== undefined,
    unlistedTypes: unlisted,
  };
};

const escapeXml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// The package.xml of the components that still exist. Written by hand, not by SDR: the org may hold types SDR
// doesn't know yet, and the Metadata API retrieves them all the same.
export const changesManifest = (changes: OrgChange[], apiVersion: string): string => {
  const members = new Map<string, Set<string>>();
  for (const change of changes.filter(({ status }) => status !== 'deleted')) {
    members.set(change.type, (members.get(change.type) ?? new Set()).add(change.fullName));
  }

  const types = [...members.keys()].sort();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...types.flatMap((type) => [
      '    <types>',
      ...[...members.get(type)!].sort().map((member) => `        <members>${escapeXml(member)}</members>`),
      `        <name>${escapeXml(type)}</name>`,
      '    </types>',
    ]),
    `    <version>${escapeXml(apiVersion)}</version>`,
    '</Package>',
    '',
  ].join('\n');
};
