import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';

import OrgChanges, { parseSince } from '../../../../src/commands/df/org/changes.js';

const AUTOMATED = '005000000000009AAA';
const COLLEAGUE = '005000000000002AAA';

const envelope = (body: string): string =>
  `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

const DESCRIBE = envelope(
  '<describeMetadataResponse><result>' +
    '<metadataObjects><inFolder>false</inFolder><xmlName>ApexClass</xmlName></metadataObjects>' +
    '<metadataObjects><childXmlNames>CustomField</childXmlNames><inFolder>false</inFolder><xmlName>CustomObject</xmlName></metadataObjects>' +
    '<metadataObjects><inFolder>false</inFolder><xmlName>Profile</xmlName></metadataObjects>' +
    '<metadataObjects><inFolder>true</inFolder><xmlName>Report</xmlName></metadataObjects>' +
    '</result></describeMetadataResponse>'
);

type Listed = { fullName: string; date: string; by?: string; byName?: string; id?: string };
// A record of a query, with JSON values only.
type Row = Record<string, string | number | boolean | null | { Name: string }>;

describe('df org changes', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  const initialCwd = process.cwd();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  let root: string;
  let soql: string[];
  let listed: Record<string, Listed[]>;
  let sourceMembers: Row[];
  let users: Array<{ Id: string; Username: string; Name: string }>;

  // The listMetadata results of a type, as the org answers them.
  const listResults = (type: string): string =>
    (listed[type] ?? [])
      .map(
        ({ fullName, date, by, byName, id }) =>
          `<result><fullName>${fullName}</fullName>${id ? `<id>${id}</id>` : ''}` +
          `<lastModifiedById>${by ?? testOrg.userId}</lastModifiedById>` +
          `<lastModifiedByName>${byName ?? 'Me'}</lastModifiedByName><lastModifiedDate>${date}</lastModifiedDate>` +
          `<manageableState>unmanaged</manageableState><type>${type}</type></result>`
      )
      .join('');

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    root = await mkdtemp(path.join(tmpdir(), 'sf-df-org-changes-command-'));
    await writeFile(
      path.join(root, 'sfdx-project.json'),
      '{\n  "packageDirectories": [{ "path": "force-app", "default": true }],\n  "sourceApiVersion": "62.0"\n}\n'
    );
    const profilesDir = path.join(root, 'force-app', 'main', 'default', 'profiles');
    await mkdir(profilesDir, { recursive: true });
    await writeFile(
      path.join(profilesDir, 'Admin.profile-meta.xml'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"/>\n'
    );
    process.chdir(root);
    $$.localPathRetriever = async () => root;
    $$.localPathRetrieverSync = () => root;
    $$.setConfigStubContents('SfProjectJson', {
      contents: { packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '62.0' },
    });
    soql = [];
    listed = {
      ApexClass: [
        { fullName: 'Old', date: '2026-10-01T08:00:00.000Z' },
        { fullName: 'Recent', date: '2026-10-20T08:00:00.000Z' },
        { fullName: 'Theirs', date: '2026-10-19T08:00:00.000Z', by: COLLEAGUE, byName: 'Colleague' },
        { fullName: 'Recalculated', date: '2026-10-22T08:00:00.000Z', by: AUTOMATED, byName: 'Automated Process' },
      ],
      Profile: [{ fullName: 'Admin', date: '2026-09-01T08:00:00.000Z', id: '00e000000000001AAA' }],
    };
    sourceMembers = [
      {
        MemberType: 'CustomField',
        MemberName: 'Account.Score__c',
        LastModifiedDate: '2026-10-21T08:00:00.000+0000',
        LastModifiedById: testOrg.userId,
        LastModifiedBy: { Name: 'Me' },
        IsNameObsolete: true,
      },
    ];
    users = [
      { Id: COLLEAGUE, Username: 'colleague@example.com', Name: 'Sam Doe' },
      { Id: '005000000000003AAA', Username: 'other@example.com', Name: 'Sam Doe' },
    ];
    $$.fakeConnectionRequest = async (request) => {
      const { url, body } = request as { url: string; body?: string };
      if (body?.includes('describeMetadata')) {
        return DESCRIBE;
      }

      if (body?.includes('listMetadata')) {
        const types = [...body.matchAll(/<m:type>([^<]*)<\/m:type>/g)].map(([, type]) => type);
        return envelope(`<listMetadataResponse>${types.map(listResults).join('')}</listMetadataResponse>`);
      }

      const query = decodeURIComponent(/[?&]q=([^&]*)/.exec(url)?.[1] ?? '').replaceAll('+', ' ');
      soql.push(query);
      const records = (rows: Row[]): { done: boolean; totalSize: number; records: Row[] } => ({
        done: true,
        totalSize: rows.length,
        records: rows,
      });
      if (url.includes('/tooling/query')) {
        return records(sourceMembers);
      }

      if (query.includes("UserType = 'AutomatedProcess'")) {
        return records([{ Id: AUTOMATED }]);
      }

      if (query.startsWith('SELECT Id, Username, Name FROM User')) {
        return records(
          users.filter((user) => query.includes(`'${user.Username}'`) || query.includes(`'${user.Name}'`))
        );
      }

      if (query.includes('FROM ObjectPermissions')) {
        return records([{ ParentId: '0PS000000000001AAA', lastChange: '2026-10-23T08:00:00.000+0000' }]);
      }

      if (query.startsWith('SELECT Id, ProfileId FROM PermissionSet')) {
        return records([{ Id: '0PS000000000001AAA', ProfileId: '00e000000000001AAA' }]);
      }

      return records([]);
    };
  });

  afterEach(async () => {
    process.chdir(initialCwd);
    $$.restore();
    await rm(root, { recursive: true, force: true });
  });

  it('lists the latest changes of every source, newest first, without Automated Process', async () => {
    const result = await OrgChanges.run(['-o', testOrg.username, '--limit', '3']);

    expect(
      result.changes.map(({ type, fullName, status, source }) => `${type}:${fullName} ${status} ${source}`)
    ).to.deep.equal([
      // The profile of the project: its accesses changed in Setup.
      'Profile:Admin changed accesses',
      'CustomField:Account.Score__c deleted tracking',
      'ApexClass:Recent changed metadata',
    ]);
    expect(result.tracking).to.equal(true);
    const table = sfCommandStubs.table.lastCall.args[0] as { data: Array<Record<string, string>> };
    expect(table.data[0]).to.include({ type: 'Profile', name: 'Admin', by: '(accesses changed)', status: 'changed' });
    expect(table.data[1]).to.include({ name: 'Account.Score__c', by: 'Me', status: 'deleted' });
  });

  it("--since lists every change since the date and --output-file writes the manifest at the project's version", async () => {
    const result = await OrgChanges.run([
      '-o',
      testOrg.username,
      '--since',
      '2026-10-15T00:00:00Z',
      '-m',
      'ApexClass',
      '-m',
      'Profile',
      '-f',
      'manifest/changes.xml',
    ]);

    expect(result.changes.map(({ fullName }) => fullName)).to.deep.equal(['Admin', 'Recent', 'Theirs']);
    expect(result.outputFile).to.equal(path.join(root, 'manifest', 'changes.xml'));
    const manifest = await readFile(path.join(root, 'manifest', 'changes.xml'), 'utf8');
    expect(manifest).to.contain('<members>Recent</members>').and.contain('<members>Theirs</members>');
    expect(manifest).to.contain('<name>Profile</name>').and.contain('<version>62.0</version>');
    const logs = sfCommandStubs.log.getCalls().map((call) => String(call.args[0]));
    expect(logs.some((line) => line.includes('sf project retrieve start --manifest'))).to.equal(true);
    expect(logs.some((line) => line.includes('sf df profile retrieve --manifest'))).to.equal(true);
    expect(soql.find((query) => query.includes('FROM SourceMember'))).to.contain(
      "LastModifiedDate >= 2026-10-15T00:00:00Z AND MemberType IN ('ApexClass', 'Profile')"
    );
  });

  it('--by me and --by a username keep the changes of these users', async () => {
    const mine = await OrgChanges.run(['-o', testOrg.username, '--by', 'me', '-m', 'ApexClass']);
    const theirs = await OrgChanges.run(['-o', testOrg.username, '--by', 'colleague@example.com', '-m', 'ApexClass']);

    expect(mine.changes.map(({ fullName }) => fullName)).to.deep.equal(['Recent', 'Old']);
    expect(theirs.changes.map(({ fullName }) => fullName)).to.deep.equal(['Theirs']);
  });

  it('refuses a full name two users share, and an unknown user', async () => {
    const ambiguous = await OrgChanges.run(['-o', testOrg.username, '--by', 'Sam Doe']).catch((error: Error) => error);
    const unknown = await OrgChanges.run(['-o', testOrg.username, '--by', 'nobody']).catch((error: Error) => error);

    expect((ambiguous as Error).message).to.contain('colleague@example.com, other@example.com');
    expect((unknown as Error).message).to.contain('No user "nobody"');
  });

  it("refuses a type the org doesn't have", async () => {
    const error = await OrgChanges.run(['-o', testOrg.username, '-m', 'ApexKlass']).catch((caught: Error) => caught);

    expect((error as Error).message).to.equal('Not a metadata type of the org: ApexKlass.');
  });

  describe('--since', () => {
    it('reads a day as local midnight and a date and time as ISO 8601', () => {
      expect(parseSince('2026-10-20').getTime()).to.equal(new Date(2026, 9, 20).getTime());
      expect(parseSince('2026-10-20T14:30:00Z').toISOString()).to.equal('2026-10-20T14:30:00.000Z');
    });

    it("refuses what isn't a date", () => {
      expect(() => parseSince('yesterday')).to.throw('"yesterday" isn\'t a date');
      expect(() => parseSince('2026-13-45')).to.throw("isn't a date");
    });
  });
});
