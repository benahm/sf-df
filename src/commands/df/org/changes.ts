import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { type Connection, Messages, type Org, SfProject } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';

import {
  changesManifest,
  listOrgChanges,
  UnknownTypesError,
  type OrgChange,
  type OrgChangesResult,
} from '../../../changes/org-changes.js';
import { orgChangesSources } from '../../../changes/org-sources.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df.org.changes');

export type OrgChangesCommandResult = OrgChangesResult & { outputFile?: string };

// Without --since, the newest changes only.
const DEFAULT_LIMIT = 20;
const USER_ID = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

// A day is local midnight, as the user means it. A date and time is read as ISO 8601.
export const parseSince = (input: string): Date => {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(input);
  // new Date(2026, 12, 45) is a date in 2027: a day must read back as written.
  const readsBack = !day || (date.getMonth() === Number(day[2]) - 1 && date.getDate() === Number(day[3]));
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(input) || !readsBack) {
    throw messages.createError('error.since', [input]);
  }

  return date;
};

const resolveProject = async (): Promise<SfProject | undefined> => {
  try {
    return await SfProject.resolve();
  } catch {
    return undefined;
  }
};

const projectApiVersion = async (project: SfProject | undefined): Promise<string | undefined> => {
  try {
    const config = await project?.resolveProjectConfig();
    return typeof config?.sourceApiVersion === 'string' ? config.sourceApiVersion : undefined;
  } catch {
    return undefined;
  }
};

type UserRecord = { Id: string; Username: string; Name: string };

const soqlList = (values: string[]): string =>
  values.map((value) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`).join(', ');

// --by: me, a username, a user Id or a full name. A name two users share is refused: the username tells them apart.
const resolveUsers = async (org: Org, connection: Connection, values: string[]): Promise<string[]> => {
  const ids = new Set<string>();
  const others = values.filter((value) => {
    if (value.toLowerCase() !== 'me') {
      return true;
    }

    const userId = connection.getAuthInfoFields().userId;
    if (userId) {
      ids.add(userId);
      return false;
    }

    return true;
  });
  const lookups = others.map((value) => (value.toLowerCase() === 'me' ? org.getUsername() ?? value : value));
  if (lookups.length === 0) {
    return [...ids];
  }

  const idFilter = lookups.filter((value) => USER_ID.test(value));
  const { records } = await connection.query<UserRecord>(
    `SELECT Id, Username, Name FROM User WHERE Username IN (${soqlList(lookups)}) OR Name IN (${soqlList(lookups)})` +
      (idFilter.length > 0 ? ` OR Id IN (${soqlList(idFilter)})` : '')
  );
  for (const value of lookups) {
    const lower = value.toLowerCase();
    const byKey = records.filter(
      (user) => user.Id === value || user.Id.slice(0, 15) === value || user.Username.toLowerCase() === lower
    );
    const matches = byKey.length > 0 ? byKey : records.filter((user) => user.Name.toLowerCase() === lower);
    if (matches.length === 0) {
      throw messages.createError('error.unknownUser', [value]);
    }

    if (matches.length > 1) {
      throw messages.createError('error.ambiguousUser', [value, matches.map((user) => user.Username).join(', ')]);
    }

    ids.add(matches[0].Id);
  }

  return [...ids];
};

// The profiles and permission sets of the project: the changes of their accesses are listed.
const accessHoldersOf = (project: SfProject): { profiles: string[]; permissionSets: string[] } => {
  const holders = { profiles: [] as string[], permissionSets: [] as string[] };
  const fsPaths = project.getPackageDirectories().map((directory) => directory.fullPath);
  for (const component of ComponentSet.fromSource({ fsPaths }).getSourceComponents()) {
    if (component.type.name === 'Profile') {
      holders.profiles.push(component.fullName);
    } else if (component.type.name === 'PermissionSet') {
      holders.permissionSets.push(component.fullName);
    }
  }

  return holders;
};

const pad = (value: number): string => String(value).padStart(2, '0');

// Local time, as the user reads it.
const displayDate = (iso: string): string => {
  const date = new Date(iso);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
};

export default class OrgChanges extends SfCommand<OrgChangesCommandResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    'api-version': Flags.orgApiVersion({
      char: 'a',
      summary: messages.getMessage('flags.api-version.summary'),
    }),
    since: Flags.string({
      summary: messages.getMessage('flags.since.summary'),
      description: messages.getMessage('flags.since.description'),
    }),
    // No default: it depends on --since (DEFAULT_LIMIT without it, every change with it).
    // eslint-disable-next-line sf-plugin/flag-min-max-default
    limit: Flags.integer({
      min: 1,
      summary: messages.getMessage('flags.limit.summary'),
      description: messages.getMessage('flags.limit.description'),
    }),
    by: Flags.string({
      multiple: true,
      summary: messages.getMessage('flags.by.summary'),
      description: messages.getMessage('flags.by.description'),
    }),
    'metadata-type': Flags.string({
      char: 'm',
      multiple: true,
      summary: messages.getMessage('flags.metadata-type.summary'),
      description: messages.getMessage('flags.metadata-type.description'),
    }),
    'output-file': Flags.file({
      char: 'f',
      summary: messages.getMessage('flags.output-file.summary'),
      description: messages.getMessage('flags.output-file.description'),
    }),
  };

  public async run(): Promise<OrgChangesCommandResult> {
    const { flags } = await this.parse(OrgChanges);
    const since = flags.since === undefined ? undefined : parseSince(flags.since);
    const org = flags['target-org'];
    const connection = org.getConnection(flags['api-version']);
    const users = flags.by ? await resolveUsers(org, connection, flags.by) : undefined;
    const project = await resolveProject();

    this.spinner.start(messages.getMessage('spinner.start', [org.getUsername()]));
    let result: OrgChangesResult;
    try {
      result = await listOrgChanges({
        sources: orgChangesSources(connection),
        since,
        limit: flags.limit ?? (since ? undefined : DEFAULT_LIMIT),
        users,
        types: flags['metadata-type'],
        accessHolders: project ? accessHoldersOf(project) : undefined,
      });
    } catch (error) {
      if (error instanceof UnknownTypesError) {
        throw messages.createError('error.unknownTypes', [error.types.join(', ')]);
      }

      throw error;
    } finally {
      this.spinner.stop();
    }

    let outputFile: string | undefined;
    if (flags['output-file']) {
      outputFile = path.resolve(flags['output-file']);
      // The retrieve writes the content of the manifest's version: the project's one, so that files keep their shape.
      const apiVersion = (await projectApiVersion(project)) ?? connection.getApiVersion();
      await mkdir(path.dirname(outputFile), { recursive: true });
      await writeFile(outputFile, changesManifest(result.changes, apiVersion), 'utf8');
    }

    this.report(result, { outputFile, inProject: project !== undefined });
    return { ...result, ...(outputFile ? { outputFile } : {}) };
  }

  private report(result: OrgChangesResult, context: { outputFile?: string; inProject: boolean }): void {
    if (result.unlistedTypes.length > 0) {
      this.warn(messages.getMessage('warning.unlisted', [result.unlistedTypes.map(({ type }) => type).join(', ')]));
    }

    if (result.changes.length === 0) {
      this.log(messages.getMessage('info.none'));
    } else {
      this.table({
        data: result.changes.map((change: OrgChange) => ({
          date: displayDate(change.lastModifiedDate),
          type: change.type,
          name: change.fullName,
          by: change.source === 'accesses' ? messages.getMessage('info.accessAuthor') : change.lastModifiedByName ?? '',
          status: change.status,
        })),
        columns: [
          { key: 'date', name: 'Date' },
          { key: 'type', name: 'Type' },
          { key: 'name', name: 'Name' },
          { key: 'by', name: 'Modified by' },
          { key: 'status', name: 'Status' },
        ],
      });
    }

    if (!result.tracking) {
      this.log(messages.getMessage('info.noTracking'));
    }

    if (!context.inProject) {
      this.log(messages.getMessage('info.noProject'));
    }

    if (context.outputFile) {
      const relative = path.relative(process.cwd(), context.outputFile) || context.outputFile;
      const components = result.changes.filter(({ status }) => status !== 'deleted');
      this.log(messages.getMessage('info.manifest', [relative, components.length, relative]));
      if (components.some(({ type }) => type === 'Profile')) {
        this.log(messages.getMessage('info.manifestProfiles', [relative]));
      }
    }
  }
}
