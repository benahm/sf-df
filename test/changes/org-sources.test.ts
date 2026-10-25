import { expect } from 'chai';

import type { Connection } from '@salesforce/core';

import { accessChanges, listOrgComponents, trackedChanges } from '../../src/changes/org-sources.js';

const envelope = (body: string): string =>
  `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

const listResponse = (components: Array<{ type: string; fullName: string }>): string =>
  envelope(
    '<listMetadataResponse>' +
      components
        .map(
          ({ type, fullName }) =>
            `<result><fullName>${fullName}</fullName><lastModifiedDate>2026-10-20T08:00:00.000Z</lastModifiedDate>` +
            `<type>${type}</type></result>`
        )
        .join('') +
      '</listMetadataResponse>'
  );

const fault = (code: string): Error =>
  new Error(
    envelope(
      `<soapenv:Fault><faultcode>sf:${code}</faultcode><faultstring>${code}: refused</faultstring></soapenv:Fault>`
    )
  );

type Query = { type: string; folder?: string };

// A connection whose listMetadata answers from `org`, by type then folder. A type mapped to an Error fails.
const fakeConnection = (
  org: Record<string, Array<{ type: string; fullName: string }> | Error>,
  calls: Query[][]
): Connection =>
  ({
    accessToken: 'token',
    getApiVersion: () => '64.0',
    request: async ({ body }: { body: string }) => {
      const queries = [
        ...body.matchAll(/<m:queries>(?:<m:folder>([^<]*)<\/m:folder>)?<m:type>([^<]*)<\/m:type><\/m:queries>/g),
      ].map(([, folder, type]) => (folder === undefined ? { type } : { type, folder }));
      calls.push(queries);
      const components = [];
      for (const { type, folder } of queries) {
        const answer = org[folder === undefined ? type : `${type}/${folder}`];
        if (answer instanceof Error) {
          throw answer;
        }

        components.push(...(answer ?? []));
      }

      return listResponse(components);
    },
  } as unknown as Connection);

describe('org changes: calls to the org', () => {
  describe('listOrgComponents', () => {
    it('asks three types per call', async () => {
      const calls: Query[][] = [];
      const connection = fakeConnection({ ApexClass: [{ type: 'ApexClass', fullName: 'Foo' }] }, calls);

      const { components } = await listOrgComponents(
        connection,
        ['ApexClass', 'ApexPage', 'ApexTrigger', 'CustomLabel'].map((name) => ({ name, inFolder: false }))
      );

      expect(calls.map((call) => call.map(({ type }) => type))).to.have.deep.members([
        ['ApexClass', 'ApexPage', 'ApexTrigger'],
        ['CustomLabel'],
      ]);
      expect(components.map(({ fullName }) => fullName)).to.deep.equal(['Foo']);
    });

    it("replays a failed call one type at a time: a type the org refuses doesn't hide the others", async () => {
      const calls: Query[][] = [];
      const connection = fakeConnection(
        {
          ApexClass: [{ type: 'ApexClass', fullName: 'Foo' }],
          // A feature not enabled: not worth a warning.
          ServicePresenceStatus: fault('INVALID_TYPE'),
          ManagedTopic: fault('INVALID_FIELD'),
        },
        calls
      );

      const { components, unlisted } = await listOrgComponents(
        connection,
        ['ApexClass', 'ServicePresenceStatus', 'ManagedTopic'].map((name) => ({ name, inFolder: false }))
      );

      expect(components.map(({ fullName }) => fullName)).to.deep.equal(['Foo']);
      expect(unlisted.map(({ type }) => type)).to.deep.equal(['ManagedTopic']);
      expect(unlisted[0].error).to.contain('INVALID_FIELD');
    });

    it('lists the folders of a type stored in folders, then each folder and the unfiled public folder', async () => {
      const calls: Query[][] = [];
      const connection = fakeConnection(
        {
          ReportFolder: [{ type: 'ReportFolder', fullName: 'Sales' }],
          'Report/Sales': [{ type: 'Report', fullName: 'Sales/Pipeline' }],
          'Report/unfiled$public': [{ type: 'Report', fullName: 'unfiled$public/Mine' }],
          DashboardFolder: [],
        },
        calls
      );

      const { components } = await listOrgComponents(connection, [
        { name: 'Report', inFolder: true },
        { name: 'Dashboard', inFolder: true },
      ]);

      expect(calls[0]).to.deep.equal([{ type: 'ReportFolder' }, { type: 'DashboardFolder' }]);
      expect(calls[1]).to.deep.equal([
        { type: 'Report', folder: 'Sales' },
        { type: 'Report', folder: 'unfiled$public' },
      ]);
      expect(components.map(({ fullName }) => fullName)).to.deep.equal(['Sales/Pipeline', 'unfiled$public/Mine']);
    });
  });

  describe('trackedChanges', () => {
    const toolingConnection = (answer: (soql: string) => unknown, queries: string[]): Connection =>
      ({
        tooling: {
          query: async (soql: string) => {
            queries.push(soql);
            return answer(soql);
          },
        },
      } as unknown as Connection);

    it('asks the types, the users and the date to the org, newest first', async () => {
      const queries: string[] = [];
      const connection = toolingConnection(
        () => ({
          records: [
            {
              MemberType: 'ApexClass',
              MemberName: 'Foo',
              LastModifiedDate: '2026-10-20T08:00:00.000+0000',
              LastModifiedById: '005A',
              LastModifiedBy: { Name: 'Me' },
              IsNameObsolete: true,
            },
          ],
        }),
        queries
      );

      const changes = await trackedChanges(connection, {
        since: new Date('2026-10-15T00:00:00.000Z'),
        users: ['005A'],
        types: ['ApexClass', "O'Brien"],
        excludedUsers: ['005Z'],
      });

      expect(queries[0]).to.equal(
        'SELECT MemberType, MemberName, LastModifiedDate, LastModifiedById, LastModifiedBy.Name, IsNameObsolete ' +
          "FROM SourceMember WHERE LastModifiedDate >= 2026-10-15T00:00:00Z AND MemberType IN ('ApexClass', 'O\\'Brien') " +
          "AND LastModifiedById IN ('005A') AND LastModifiedById NOT IN ('005Z') ORDER BY LastModifiedDate DESC"
      );
      expect(changes).to.deep.equal([
        {
          type: 'ApexClass',
          fullName: 'Foo',
          lastModifiedDate: '2026-10-20T08:00:00.000+0000',
          lastModifiedById: '005A',
          lastModifiedByName: 'Me',
          deleted: true,
        },
      ]);
    });

    it('limits the rows without --since, and returns undefined for an org without source tracking', async () => {
      const queries: string[] = [];
      const limited = toolingConnection(() => ({ records: [] }), queries);
      await trackedChanges(limited, { limit: 20, types: ['ApexClass'], excludedUsers: [] });
      const untracked = toolingConnection(() => {
        throw new Error("sObject type 'SourceMember' is not supported.");
      }, []);

      expect(queries[0]).to.match(/WHERE MemberType IN \('ApexClass'\) ORDER BY LastModifiedDate DESC LIMIT 20$/);
      expect(await trackedChanges(untracked, { types: ['ApexClass'], excludedUsers: [] })).to.equal(undefined);
    });
  });

  describe('accessChanges', () => {
    it("reads the newest permission row of each holder, and names the profile of a profile's permission set", async () => {
      const queries: string[] = [];
      const connection = {
        query: async (soql: string) => {
          queries.push(soql);
          if (soql.startsWith('SELECT Id, ProfileId FROM PermissionSet')) {
            return {
              records: [
                { Id: '0PSP', ProfileId: '00eA' },
                { Id: '0PSR', ProfileId: null },
              ],
            };
          }

          const rows: Record<string, Array<{ ParentId: string; lastChange: string }>> = {
            FieldPermissions: [{ ParentId: '0PSP', lastChange: '2026-10-20T08:00:00.000+0000' }],
            PermissionSetTabSetting: [
              { ParentId: '0PSP', lastChange: '2026-10-21T08:00:00.000+0000' },
              { ParentId: '0PSR', lastChange: '2026-10-19T08:00:00.000+0000' },
            ],
          };
          return { records: rows[/FROM (\w+)/.exec(soql)![1]] ?? [] };
        },
      } as unknown as Connection;

      const changes = await accessChanges(
        connection,
        { profileIds: ['00eA'], permissionSetIds: ['0PSR'] },
        { since: new Date('2026-10-15T00:00:00.000Z') }
      );

      expect(changes).to.have.deep.members([
        { profileId: '00eA', lastModifiedDate: '2026-10-21T08:00:00.000+0000' },
        { permissionSetId: '0PSR', lastModifiedDate: '2026-10-19T08:00:00.000+0000' },
      ]);
      expect(queries).to.include(
        "SELECT ParentId, MAX(SystemModstamp) lastChange FROM FieldPermissions WHERE Parent.ProfileId IN ('00eA') " +
          'AND SystemModstamp >= 2026-10-15T00:00:00Z GROUP BY ParentId ORDER BY MAX(SystemModstamp) DESC'
      );
      expect(queries.filter((soql) => soql.includes("ParentId IN ('0PSR')"))).to.have.length(4);
    });

    it('asks nothing when there is no holder', async () => {
      const connection = {
        query: async () => {
          throw new Error('no call expected');
        },
      } as unknown as Connection;

      expect(await accessChanges(connection, { profileIds: [], permissionSetIds: [] }, {})).to.deep.equal([]);
    });
  });
});
