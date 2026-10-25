import type { Connection } from '@salesforce/core';

import {
  describeMetadataTypes,
  listFileProperties,
  LIST_QUERIES_PER_CALL,
  SoapFaultError,
  type FileProperties,
  type ListQuery,
  type MetadataTypeInfo,
} from '../retrieve/metadata-read.js';
import type { AccessChange, ChangeQuery, OrgChangesSources, TrackedChange } from './org-changes.js';

const DEFAULT_CONCURRENCY = 10;
// One new attempt only: a type the org can't list (ManagedTopic) fails with UNKNOWN_EXCEPTION every time, and three
// attempts cost 14 s (measured in a sandbox).
const LIST_OPTIONS = { retries: 1, retryDelayMs: 1000 };
// Ids per IN list: the query stays well below the length limit of SOQL.
const IDS_PER_QUERY = 200;

// The folders of a type stored in folders are a type of their own. Reports and email templates may also sit in the
// unfiled public folder, which listMetadata doesn't list.
const FOLDER_TYPES: Record<string, string> = {
  Dashboard: 'DashboardFolder',
  Document: 'DocumentFolder',
  EmailTemplate: 'EmailFolder',
  Report: 'ReportFolder',
};
const UNFILED_FOLDER = 'unfiled$public';
const UNFILED_TYPES = new Set(['EmailTemplate', 'Report']);

// INVALID_TYPE: the type can't be listed in this org (a feature not enabled). Not worth a warning.
const isInvalidType = (error: unknown): boolean =>
  error instanceof SoapFaultError && error.faultCode.endsWith('INVALID_TYPE');

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const pool = async <T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> => {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      // eslint-disable-next-line no-await-in-loop
      await run(item);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
};

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

type ListOutcome = { components: FileProperties[]; unlisted: Array<{ type: string; error: string }> };

// Runs the queries LIST_QUERIES_PER_CALL at a time. A call that fails is replayed one query at a time, so that one
// type the org refuses doesn't hide the two others.
const runQueries = async (connection: Connection, queries: ListQuery[], concurrency: number): Promise<ListOutcome> => {
  const outcome: ListOutcome = { components: [], unlisted: [] };
  const failed = new Map<string, string>();
  const runOne = async (query: ListQuery): Promise<void> => {
    try {
      outcome.components.push(...(await listFileProperties(connection, [query], LIST_OPTIONS)));
    } catch (error) {
      if (!isInvalidType(error)) {
        failed.set(query.type, messageOf(error));
      }
    }
  };

  await pool(chunks(queries, LIST_QUERIES_PER_CALL), concurrency, async (batch) => {
    try {
      outcome.components.push(...(await listFileProperties(connection, batch, LIST_OPTIONS)));
    } catch {
      for (const query of batch) {
        // eslint-disable-next-line no-await-in-loop
        await runOne(query);
      }
    }
  });
  outcome.unlisted = [...failed].map(([type, error]) => ({ type, error })).sort((a, b) => a.type.localeCompare(b.type));
  return outcome;
};

// Every component of the given types, with its date and author.
export const listOrgComponents = async (
  connection: Connection,
  types: MetadataTypeInfo[],
  concurrency = DEFAULT_CONCURRENCY
): Promise<ListOutcome> => {
  const folderTypes = types.filter((type) => type.inFolder);
  const folders = await runQueries(
    connection,
    folderTypes.map((type) => ({ type: FOLDER_TYPES[type.name] ?? `${type.name}Folder` })),
    concurrency
  );
  const contentType = new Map(folderTypes.map((type) => [FOLDER_TYPES[type.name] ?? `${type.name}Folder`, type.name]));
  const folderQueries: ListQuery[] = [
    ...folders.components.flatMap((folder) => {
      const type = contentType.get(folder.type);
      return type ? [{ type, folder: folder.fullName }] : [];
    }),
    ...folderTypes
      .filter((type) => UNFILED_TYPES.has(type.name))
      .map((type) => ({ type: type.name, folder: UNFILED_FOLDER })),
  ];

  const listed = await runQueries(
    connection,
    [...types.filter((type) => !type.inFolder).map((type) => ({ type: type.name })), ...folderQueries],
    concurrency
  );
  return { components: listed.components, unlisted: [...folders.unlisted, ...listed.unlisted] };
};

const soqlString = (value: string): string => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const soqlList = (values: string[]): string => values.map(soqlString).join(', ');
// SOQL datetime literal: no milliseconds, UTC.
const soqlDate = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

type SourceMemberRecord = {
  MemberType: string;
  MemberName: string;
  LastModifiedDate: string;
  LastModifiedById?: string;
  LastModifiedBy?: { Name?: string } | null;
  IsNameObsolete: boolean;
};

// Changes recorded by source tracking, deletions included. Undefined when the org has no source tracking.
export const trackedChanges = async (
  connection: Connection,
  query: ChangeQuery & { types: string[]; excludedUsers: string[] }
): Promise<TrackedChange[] | undefined> => {
  const where = [
    ...(query.since ? [`LastModifiedDate >= ${soqlDate(query.since)}`] : []),
    `MemberType IN (${soqlList(query.types)})`,
    ...(query.users ? [`LastModifiedById IN (${soqlList(query.users)})`] : []),
    ...(query.excludedUsers.length > 0 ? [`LastModifiedById NOT IN (${soqlList(query.excludedUsers)})`] : []),
  ];
  const soql =
    'SELECT MemberType, MemberName, LastModifiedDate, LastModifiedById, LastModifiedBy.Name, IsNameObsolete ' +
    `FROM SourceMember WHERE ${where.join(' AND ')} ORDER BY LastModifiedDate DESC` +
    (query.since === undefined && query.limit !== undefined ? ` LIMIT ${query.limit}` : '');
  let records: SourceMemberRecord[];
  try {
    ({ records } = await connection.tooling.query<SourceMemberRecord>(soql, { autoFetch: true, maxFetch: 1_000_000 }));
  } catch {
    return undefined;
  }

  return records.map((record) => ({
    type: record.MemberType,
    fullName: record.MemberName,
    lastModifiedDate: record.LastModifiedDate,
    lastModifiedById: record.LastModifiedById,
    lastModifiedByName: record.LastModifiedBy?.Name,
    deleted: record.IsNameObsolete,
  }));
};

// The rows that hold the accesses of a profile or permission set. Each has a SystemModstamp, no author.
const ACCESS_ENTITIES = ['FieldPermissions', 'ObjectPermissions', 'SetupEntityAccess', 'PermissionSetTabSetting'];

// The newest change of the accesses of these profiles and permission sets: the permission rows changed in Setup move
// neither the profile's listMetadata date nor SourceMember (verified on a scratch org). A revoked access deletes its
// row: it leaves no trace.
export const accessChanges = async (
  connection: Connection,
  holders: { profileIds: string[]; permissionSetIds: string[] },
  query: ChangeQuery
): Promise<AccessChange[]> => {
  const newest = new Map<string, string>();
  const filters = [
    ...chunks(holders.profileIds, IDS_PER_QUERY).map((ids) => `Parent.ProfileId IN (${soqlList(ids)})`),
    ...chunks(holders.permissionSetIds, IDS_PER_QUERY).map((ids) => `ParentId IN (${soqlList(ids)})`),
  ];
  const queries = ACCESS_ENTITIES.flatMap((entity) =>
    filters.map(
      (filter) =>
        `SELECT ParentId, MAX(SystemModstamp) lastChange FROM ${entity} WHERE ${filter}` +
        (query.since ? ` AND SystemModstamp >= ${soqlDate(query.since)}` : '') +
        ' GROUP BY ParentId ORDER BY MAX(SystemModstamp) DESC' +
        (query.since === undefined && query.limit !== undefined ? ` LIMIT ${query.limit}` : '')
    )
  );
  await pool(queries, DEFAULT_CONCURRENCY, async (soql) => {
    const { records } = await connection.query<{ ParentId: string; lastChange: string }>(soql);
    for (const { ParentId, lastChange } of records) {
      if (!newest.has(ParentId) || newest.get(ParentId)! < lastChange) {
        newest.set(ParentId, lastChange);
      }
    }
  });
  if (newest.size === 0) {
    return [];
  }

  // The permission set of a profile holds its accesses: its ProfileId names the profile.
  const profileOf = new Map<string, string | undefined>();
  for (const ids of chunks([...newest.keys()], IDS_PER_QUERY)) {
    // eslint-disable-next-line no-await-in-loop
    const { records } = await connection.query<{ Id: string; ProfileId?: string | null }>(
      `SELECT Id, ProfileId FROM PermissionSet WHERE Id IN (${soqlList(ids)})`
    );
    records.forEach((record) => profileOf.set(record.Id, record.ProfileId ?? undefined));
  }

  return [...newest].map(([parentId, lastModifiedDate]) => {
    const profileId = profileOf.get(parentId);
    return profileId ? { profileId, lastModifiedDate } : { permissionSetId: parentId, lastModifiedDate };
  });
};

// Found by user type, not by name: the name of a user can change.
export const automatedUsers = async (connection: Connection): Promise<string[]> =>
  (await connection.query<{ Id: string }>("SELECT Id FROM User WHERE UserType = 'AutomatedProcess'")).records.map(
    (record) => record.Id
  );

export const orgChangesSources = (connection: Connection): OrgChangesSources => ({
  describeTypes: () => describeMetadataTypes(connection),
  automatedUsers: () => automatedUsers(connection),
  listComponents: (types) => listOrgComponents(connection, types),
  trackedChanges: (query) => trackedChanges(connection, query),
  accessChanges: (holders, query) => accessChanges(connection, holders, query),
});
