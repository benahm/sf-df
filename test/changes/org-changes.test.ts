import { expect } from 'chai';

import {
  changesManifest,
  listOrgChanges,
  UnknownTypesError,
  type AccessChange,
  type ChangeQuery,
  type OrgChangesOptions,
  type TrackedChange,
} from '../../src/changes/org-changes.js';
import type { FileProperties, MetadataTypeInfo } from '../../src/retrieve/metadata-read.js';

const ME = '005000000000001AAA';
const COLLEAGUE = '005000000000002AAA';
const AUTOMATED = '005000000000009AAA';

const TYPES: MetadataTypeInfo[] = [
  { name: 'ApexClass', inFolder: false },
  { name: 'CustomField', inFolder: false },
  { name: 'CustomLabel', inFolder: false },
  { name: 'PermissionSet', inFolder: false },
  { name: 'PermissionSetGroup', inFolder: false },
  { name: 'Profile', inFolder: false },
  { name: 'Report', inFolder: true },
];

const listed = (
  type: string,
  fullName: string,
  lastModifiedDate: string,
  extra: Partial<FileProperties> = {}
): FileProperties => ({
  type,
  fullName,
  lastModifiedDate,
  lastModifiedById: ME,
  lastModifiedByName: 'Me',
  manageableState: 'unmanaged',
  ...extra,
});

const tracked = (
  type: string,
  fullName: string,
  lastModifiedDate: string,
  extra: Partial<TrackedChange> = {}
): TrackedChange => ({
  type,
  fullName,
  lastModifiedDate,
  lastModifiedById: ME,
  lastModifiedByName: 'Me',
  deleted: false,
  ...extra,
});

type Org = {
  components?: FileProperties[];
  // Undefined: the org has no source tracking.
  tracking?: TrackedChange[];
  accesses?: AccessChange[];
};

// What each source was asked, to check what reaches the org.
type Calls = {
  listedTypes: string[];
  trackingQuery?: ChangeQuery & { types: string[]; excludedUsers: string[] };
  accessHolders?: { profileIds: string[]; permissionSetIds: string[] };
};

const run = async (
  org: Org,
  options: Partial<OrgChangesOptions> = {}
): Promise<{ result: Awaited<ReturnType<typeof listOrgChanges>>; calls: Calls }> => {
  const calls: Calls = { listedTypes: [] };
  const result = await listOrgChanges({
    sources: {
      describeTypes: async () => TYPES,
      automatedUsers: async () => [AUTOMATED],
      listComponents: async (types) => {
        calls.listedTypes = types.map((type) => type.name);
        const names = new Set(calls.listedTypes);
        return { components: (org.components ?? []).filter((component) => names.has(component.type)), unlisted: [] };
      },
      trackedChanges: async (query) => {
        calls.trackingQuery = query;
        return org.tracking;
      },
      accessChanges: async (holders) => {
        calls.accessHolders = holders;
        return org.accesses ?? [];
      },
    },
    ...options,
  });
  return { result, calls };
};

const lines = (result: Awaited<ReturnType<typeof listOrgChanges>>): string[] =>
  result.changes.map((change) => `${change.type}:${change.fullName} ${change.status} ${change.source}`);

describe('org changes', () => {
  it('lists the components newest first, up to the limit', async () => {
    const { result } = await run(
      {
        components: [
          listed('ApexClass', 'Old', '2026-10-01T08:00:00.000Z'),
          listed('ApexClass', 'New', '2026-10-20T08:00:00.000Z'),
          listed('CustomLabel', 'Middle', '2026-10-10T08:00:00.000Z'),
        ],
      },
      { limit: 2 }
    );

    expect(lines(result)).to.deep.equal(['ApexClass:New changed metadata', 'CustomLabel:Middle changed metadata']);
    expect(result.changes[0]).to.include({ lastModifiedById: ME, lastModifiedByName: 'Me' });
  });

  it('leaves out the components of installed packages and the types without a date', async () => {
    const { result } = await run({
      components: [
        listed('ApexClass', 'ns__Managed', '2026-10-20T08:00:00.000Z', { manageableState: 'installed' }),
        listed('ApexClass', 'ns__Editable', '2026-10-20T08:00:00.000Z', { manageableState: 'installedEditable' }),
        listed('CustomLabel', 'Undated', '1970-01-01T00:00:00.000Z'),
        listed('ApexClass', 'Mine', '2026-10-20T08:00:00.000Z'),
      ],
    });

    expect(lines(result)).to.deep.equal(['ApexClass:Mine changed metadata']);
  });

  it('keeps the newest change of a component found by several sources', async () => {
    const { result } = await run({
      components: [listed('ApexClass', 'Foo', '2026-10-10T08:00:00.000Z')],
      tracking: [
        tracked('ApexClass', 'foo', '2026-10-12T08:00:00.000Z', {
          lastModifiedById: COLLEAGUE,
          lastModifiedByName: 'Colleague',
        }),
      ],
    });

    expect(lines(result)).to.deep.equal(['ApexClass:foo changed tracking']);
    expect(result.changes[0].lastModifiedByName).to.equal('Colleague');
  });

  it('lists a deletion of source tracking as deleted, unless the component exists again', async () => {
    const { result } = await run({
      components: [listed('ApexClass', 'Recreated', '2026-10-10T08:00:00.000Z')],
      tracking: [
        tracked('ApexClass', 'Gone', '2026-10-12T08:00:00.000Z', { deleted: true }),
        tracked('ApexClass', 'Recreated', '2026-10-12T08:00:00.000Z', { deleted: true }),
      ],
    });

    expect(lines(result)).to.deep.equal(['ApexClass:Gone deleted tracking', 'ApexClass:Recreated changed tracking']);
    expect(result.tracking).to.equal(true);
  });

  it('says when the org has no source tracking', async () => {
    const { result } = await run({ components: [listed('ApexClass', 'Foo', '2026-10-10T08:00:00.000Z')] });

    expect(result.tracking).to.equal(false);
  });

  it('leaves out the parts of components source tracking records that are no metadata type', async () => {
    const { result } = await run({
      tracking: [
        tracked('LightningComponentResource', 'card/card.js', '2026-10-12T08:00:00.000Z'),
        tracked('ApexClass', 'Foo', '2026-10-11T08:00:00.000Z'),
      ],
    });

    expect(lines(result)).to.deep.equal(['ApexClass:Foo changed tracking']);
  });

  it('--since keeps the changes made since the date, every source alike', async () => {
    const since = new Date('2026-10-15T00:00:00.000Z');
    const { result, calls } = await run(
      {
        components: [
          listed('ApexClass', 'Before', '2026-10-14T23:59:59.000Z'),
          listed('ApexClass', 'After', '2026-10-15T00:00:00.000Z'),
        ],
        tracking: [tracked('ApexClass', 'TrackedBefore', '2026-10-01T08:00:00.000Z')],
      },
      { since }
    );

    expect(lines(result)).to.deep.equal(['ApexClass:After changed metadata']);
    expect(calls.trackingQuery?.since).to.equal(since);
  });

  it('--by keeps the changes of these users, compared on 15 characters', async () => {
    const { result, calls } = await run(
      {
        components: [
          listed('ApexClass', 'Mine', '2026-10-10T08:00:00.000Z'),
          listed('ApexClass', 'Theirs', '2026-10-11T08:00:00.000Z', { lastModifiedById: COLLEAGUE }),
        ],
        tracking: [
          tracked('ApexClass', 'TrackedMine', '2026-10-12T08:00:00.000Z', { lastModifiedById: ME.slice(0, 15) }),
        ],
      },
      { users: [ME] }
    );

    expect(lines(result)).to.deep.equal(['ApexClass:TrackedMine changed tracking', 'ApexClass:Mine changed metadata']);
    expect(calls.trackingQuery?.users).to.deep.equal([ME]);
    expect(calls.trackingQuery?.excludedUsers).to.deep.equal([]);
  });

  it('leaves out the recalculations of Automated Process, before keeping the newest change', async () => {
    const { result, calls } = await run({
      components: [
        listed('PermissionSetGroup', 'Sales', '2026-10-20T08:00:00.000Z', { lastModifiedById: AUTOMATED }),
        listed('ApexClass', 'Foo', '2026-10-10T08:00:00.000Z'),
      ],
      tracking: [tracked('PermissionSetGroup', 'Sales', '2026-10-12T08:00:00.000Z')],
    });

    // The change made by someone before the recalculation is still listed.
    expect(lines(result)).to.deep.equal([
      'PermissionSetGroup:Sales changed tracking',
      'ApexClass:Foo changed metadata',
    ]);
    expect(calls.trackingQuery?.excludedUsers).to.deep.equal([AUTOMATED]);
  });

  describe('types', () => {
    it('lists every type but those stored in folders, and asks source tracking for the same types', async () => {
      const { calls } = await run({});

      expect(calls.listedTypes).to.deep.equal([
        'ApexClass',
        'CustomField',
        'CustomLabel',
        'PermissionSet',
        'PermissionSetGroup',
        'Profile',
      ]);
      expect(calls.trackingQuery?.types).to.deep.equal(calls.listedTypes);
    });

    it('--metadata-type lists only these types, folders included, whatever their case', async () => {
      const { calls } = await run({}, { types: ['report', 'ApexClass'] });

      expect(calls.listedTypes).to.deep.equal(['Report', 'ApexClass']);
    });

    it("refuses a type the org doesn't have", async () => {
      const error = await run({}, { types: ['ApexClass', 'ApexKlass'] }).catch((caught: unknown) => caught);

      expect(error).to.be.instanceOf(UnknownTypesError);
      expect((error as UnknownTypesError).types).to.deep.equal(['ApexKlass']);
    });

    it('reads the custom fields from source tracking when the org has it, from listMetadata otherwise', async () => {
      const field = listed('CustomField', 'Account.Score__c', '2026-10-10T08:00:00.000Z');

      const withTracking = await run({ components: [field], tracking: [] });
      const withoutTracking = await run({ components: [field] });

      expect(withTracking.calls.listedTypes).not.to.include('CustomField');
      expect(withoutTracking.calls.listedTypes).to.include('CustomField');
      expect(lines(withoutTracking.result)).to.deep.equal(['CustomField:Account.Score__c changed metadata']);
    });
  });

  describe("accesses of the project's profiles and permission sets", () => {
    const components = [
      listed('Profile', 'Standard', '2026-10-01T08:00:00.000Z', { id: '00e000000000001AAA' }),
      listed('Profile', 'Other', '2026-10-01T08:00:00.000Z', { id: '00e000000000002AAA' }),
      listed('PermissionSet', 'Sales', '2026-10-01T08:00:00.000Z', { id: '0PS000000000001AAA' }),
    ];

    it('lists them, without author, whatever --by says: Setup moves no other date (verified on a scratch org)', async () => {
      const { result, calls } = await run(
        {
          components,
          accesses: [
            { profileId: '00e000000000001', lastModifiedDate: '2026-10-20T08:00:00.000+0000' },
            { permissionSetId: '0PS000000000001AAA', lastModifiedDate: '2026-10-19T08:00:00.000+0000' },
          ],
        },
        { accessHolders: { profiles: ['standard'], permissionSets: ['Sales'] }, users: [COLLEAGUE] }
      );

      expect(calls.accessHolders).to.deep.equal({
        profileIds: ['00e000000000001'],
        permissionSetIds: ['0PS000000000001'],
      });
      expect(lines(result)).to.deep.equal([
        'Profile:Standard changed accesses',
        'PermissionSet:Sales changed accesses',
      ]);
      expect(result.changes[0].lastModifiedById).to.equal(undefined);
      expect(result.changes[0].lastModifiedDate).to.equal('2026-10-20T08:00:00.000Z');
    });

    it("doesn't look for them outside a project, nor when profiles and permission sets aren't listed", async () => {
      const outside = await run({ components });
      const otherTypes = await run(
        { components },
        { types: ['ApexClass'], accessHolders: { profiles: ['Standard'], permissionSets: ['Sales'] } }
      );

      expect(outside.calls.accessHolders).to.equal(undefined);
      expect(otherTypes.calls.accessHolders).to.equal(undefined);
    });
  });

  describe('changesManifest', () => {
    it('writes the components that still exist, sorted, with the API version', () => {
      const xml = changesManifest(
        [
          {
            type: 'CustomField',
            fullName: 'Account.B__c',
            lastModifiedDate: '',
            status: 'changed',
            source: 'tracking',
          },
          { type: 'ApexClass', fullName: 'R&D', lastModifiedDate: '', status: 'changed', source: 'metadata' },
          {
            type: 'CustomField',
            fullName: 'Account.A__c',
            lastModifiedDate: '',
            status: 'changed',
            source: 'tracking',
          },
          { type: 'ApexClass', fullName: 'Gone', lastModifiedDate: '', status: 'deleted', source: 'tracking' },
          // A type SDR doesn't know yet is written all the same.
          { type: 'BrandNewType', fullName: 'X', lastModifiedDate: '', status: 'changed', source: 'metadata' },
        ],
        '64.0'
      );

      expect(xml).to.equal(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
          '    <types>',
          '        <members>R&amp;D</members>',
          '        <name>ApexClass</name>',
          '    </types>',
          '    <types>',
          '        <members>X</members>',
          '        <name>BrandNewType</name>',
          '    </types>',
          '    <types>',
          '        <members>Account.A__c</members>',
          '        <members>Account.B__c</members>',
          '        <name>CustomField</name>',
          '    </types>',
          '    <version>64.0</version>',
          '</Package>',
          '',
        ].join('\n')
      );
    });
  });
});
