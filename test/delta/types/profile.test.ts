import { expect } from 'chai';

import { useDeltaRepo } from '../helpers/delta-repo.js';
import {
  applicationVisibility,
  classAccess,
  customPermissionAccess,
  fieldPermission,
  layoutAssignment,
  loginIpRange,
  objectPermission,
  pageAccess,
  profileXml,
  recordTypeVisibility,
  tabVisibility,
  userPermission,
} from '../helpers/metadata-xml.js';

// Profile: partial XML keyed by collection, with the root fields Salesforce requires (custom, userLicense).
// See docs/git-delta-metadata-strategies.md (ProfileStrategy).

const PROFILE = 'profiles/Sales.profile-meta.xml';

const base = [
  applicationVisibility('standard__Sales', true, true),
  classAccess('InvoiceService'),
  customPermissionAccess('ApproveInvoices'),
  fieldPermission('Invoice__c.Amount__c'),
  fieldPermission('Invoice__c.Status__c', false),
  layoutAssignment('Invoice__c-Invoice Layout'),
  layoutAssignment('Invoice__c-Invoice B2B Layout', 'Invoice__c.B2B'),
  loginIpRange('10.0.0.0', '10.0.0.255'),
  objectPermission('Invoice__c'),
  pageAccess('InvoicePdf'),
  recordTypeVisibility('Invoice__c.B2B', true, true),
  tabVisibility('Invoice__c'),
  userPermission('ApiEnabled'),
];

const withReplaced = (from: string, to: string): string[] => base.map((item) => (item === from ? to : item));

describe('delta by type: Profile', () => {
  const ctx = useDeltaRepo();

  const changeProfile = async (items: string[]): Promise<string> => {
    await ctx.repo.baseline({ [PROFILE]: profileXml(...base) });
    await ctx.repo.write({ [PROFILE]: profileXml(...items) });
    const delta = await ctx.repo.delta();
    expect(delta.package).to.deep.equal(['Profile:Sales']);
    expect(delta.destructive).to.deep.equal([]);
    return delta.packageFile(PROFILE);
  };

  const expectRequiredRootFields = (xml: string): void => {
    expect(xml).to.contain('<custom>true</custom>');
    expect(xml).to.contain('<userLicense>Salesforce</userLicense>');
  };

  describe('additions', () => {
    it('ships a new profile whole', async () => {
      await ctx.repo.baseline({ 'profiles/Other.profile-meta.xml': profileXml() });
      await ctx.repo.write({ [PROFILE]: profileXml(...base) });

      const delta = await ctx.repo.delta();
      const xml = await delta.packageFile(PROFILE);

      expect(delta.package).to.deep.equal(['Profile:Sales']);
      for (const marker of [
        'Invoice__c.Amount__c',
        'InvoiceService',
        'InvoicePdf',
        'ApiEnabled',
        '10.0.0.0',
        'ApproveInvoices',
      ]) {
        expect(xml).to.contain(marker);
      }
      expectRequiredRootFields(xml);
    });

    it('keeps the encoded file name as the full name', async () => {
      const file = 'profiles/Custom%3A Sales Profile.profile-meta.xml';
      await ctx.repo.baseline({ [file]: profileXml(userPermission('ApiEnabled')) });
      await ctx.repo.write({ [file]: profileXml(userPermission('ApiEnabled', false)) });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['Profile:Custom%3A Sales Profile']);
    });
  });

  // One test per keyed collection: only the changed or added item is shipped.
  const collections: Array<{
    name: string;
    from: string;
    to: string;
    changed: string;
    unchanged: string;
  }> = [
    {
      name: 'fieldPermissions',
      from: fieldPermission('Invoice__c.Amount__c'),
      to: fieldPermission('Invoice__c.Amount__c', false),
      changed: 'Invoice__c.Amount__c',
      unchanged: 'Invoice__c.Status__c',
    },
    {
      name: 'objectPermissions',
      from: objectPermission('Invoice__c'),
      to: objectPermission('Invoice__c', true, false),
      changed: '<object>Invoice__c</object>',
      unchanged: 'Invoice__c.Amount__c',
    },
    {
      name: 'classAccesses',
      from: classAccess('InvoiceService'),
      to: classAccess('InvoiceService', false),
      changed: 'InvoiceService',
      unchanged: 'InvoicePdf',
    },
    {
      name: 'pageAccesses',
      from: pageAccess('InvoicePdf'),
      to: pageAccess('InvoicePdf', false),
      changed: 'InvoicePdf',
      unchanged: 'InvoiceService',
    },
    {
      name: 'tabVisibilities',
      from: tabVisibility('Invoice__c'),
      to: tabVisibility('Invoice__c', 'Hidden'),
      changed: '<visibility>Hidden</visibility>',
      unchanged: 'ApiEnabled',
    },
    {
      name: 'userPermissions',
      from: userPermission('ApiEnabled'),
      to: userPermission('ApiEnabled', false),
      changed: 'ApiEnabled',
      unchanged: 'InvoicePdf',
    },
    {
      name: 'applicationVisibilities',
      from: applicationVisibility('standard__Sales', true, true),
      to: applicationVisibility('standard__Sales', true, false),
      changed: 'standard__Sales',
      unchanged: 'ApiEnabled',
    },
    {
      name: 'recordTypeVisibilities',
      from: recordTypeVisibility('Invoice__c.B2B', true, true),
      to: recordTypeVisibility('Invoice__c.B2B', false, false),
      changed: '<recordType>Invoice__c.B2B</recordType>',
      unchanged: 'ApiEnabled',
    },
    {
      name: 'customPermissions',
      from: customPermissionAccess('ApproveInvoices'),
      to: customPermissionAccess('ApproveInvoices', false),
      changed: 'ApproveInvoices',
      unchanged: 'ApiEnabled',
    },
  ];

  describe('modifications', () => {
    for (const { name, from, to, changed, unchanged } of collections) {
      it(`ships only the changed ${name} item`, async () => {
        const xml = await changeProfile(withReplaced(from, to));

        expect(xml).to.contain(changed);
        expect(xml).not.to.contain(unchanged);
        expectRequiredRootFields(xml);
      });
    }

    it('ships an added item of a collection without the existing ones', async () => {
      const xml = await changeProfile([...base, fieldPermission('Invoice__c.Due__c')]);

      expect(xml).to.contain('Invoice__c.Due__c');
      expect(xml).not.to.contain('Invoice__c.Amount__c');
    });

    it('keys layout assignments by layout and record type', async () => {
      const xml = await changeProfile([...base, layoutAssignment('Invoice__c-Invoice Layout', 'Invoice__c.B2C')]);

      expect(xml).to.contain('<recordType>Invoice__c.B2C</recordType>');
      // The assignment of the same layout without record type is unchanged.
      expect(xml.match(/<layoutAssignments>/g)).to.have.length(1);
    });

    it('ships the new layout of a record type whose assignment changed', async () => {
      const xml = await changeProfile(
        withReplaced(
          layoutAssignment('Invoice__c-Invoice B2B Layout', 'Invoice__c.B2B'),
          layoutAssignment('Invoice__c-Invoice Layout', 'Invoice__c.B2B')
        )
      );

      expect(xml).to.contain('<layout>Invoice__c-Invoice Layout</layout>');
      expect(xml).to.contain('<recordType>Invoice__c.B2B</recordType>');
    });

    it('ships a changed login IP range', async () => {
      const xml = await changeProfile(
        withReplaced(loginIpRange('10.0.0.0', '10.0.0.255'), loginIpRange('10.0.0.0', '10.0.1.255'))
      );

      expect(xml).to.contain('<endAddress>10.0.1.255</endAddress>');
    });

    it('ships a changed description with the required root fields', async () => {
      const xml = await changeProfile([...base, '<description>Sales team</description>']);

      expect(xml).to.contain('<description>Sales team</description>');
      expect(xml).not.to.contain('<fieldPermissions>');
      expectRequiredRootFields(xml);
    });

    it('ships changes to several collections at once', async () => {
      const xml = await changeProfile([
        ...withReplaced(classAccess('InvoiceService'), classAccess('InvoiceService', false)),
        fieldPermission('Invoice__c.Due__c'),
        tabVisibility('Payment__c'),
      ]);

      expect(xml).to.contain('InvoiceService');
      expect(xml).to.contain('Invoice__c.Due__c');
      expect(xml).to.contain('Payment__c');
      expect(xml).not.to.contain('InvoicePdf');
    });
  });

  describe('removed items', () => {
    // Known gap, to decide. Verified in a sandbox: deploying a profile never removes what its XML does not mention,
    // even with the full file, so an item removed from the file stays granted in the org, and the delta says nothing
    // about it. Setting the access to false in git (tested above) does revoke it.
    it('ships nothing and warns about nothing when an item is removed from the file', async () => {
      await ctx.repo.baseline({ [PROFILE]: profileXml(...base) });
      await ctx.repo.write({
        [PROFILE]: profileXml(...base.filter((item) => item !== classAccess('InvoiceService'))),
      });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal([]);
      expect(delta.destructive).to.deep.equal([]);
      expect(delta.warnings).to.equal('');
    });

    it('ships only the other changes when an item is removed together with a change', async () => {
      const xml = await changeProfile([
        ...base.filter((item) => item !== classAccess('InvoiceService')),
        userPermission('ViewSetup'),
      ]);

      expect(xml).to.contain('ViewSetup');
      expect(xml).not.to.contain('InvoiceService');
    });
  });

  describe('no-op changes', () => {
    it('ships nothing for a pure reformatting', async () => {
      await ctx.repo.baseline({ [PROFILE]: profileXml(...base) });
      await ctx.repo.write({
        [PROFILE]: profileXml(...base)
          .replaceAll('\n', '\r\n')
          .replaceAll('    <', '  <'),
      });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal([]);
    });

    it('ships nothing when items are only reordered', async () => {
      await ctx.repo.baseline({ [PROFILE]: profileXml(...base) });
      await ctx.repo.write({ [PROFILE]: profileXml(...[...base].reverse()) });

      expect((await ctx.repo.delta()).package).to.deep.equal([]);
    });
  });

  describe('deletions and renames', () => {
    it('lists a deleted profile in destructiveChanges.xml with a warning', async () => {
      await ctx.repo.baseline({
        [PROFILE]: profileXml(...base),
        'profiles/Other.profile-meta.xml': profileXml(),
      });
      await ctx.repo.remove(PROFILE);

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal(['Profile:Sales']);
      expect(delta.package).to.deep.equal([]);
      expect(delta.warnings).to.contain('Profile:Sales');
    });

    it('turns a rename into a deleted profile plus a complete new one', async () => {
      await ctx.repo.baseline({ [PROFILE]: profileXml(...base) });
      ctx.repo.rename(PROFILE, 'profiles/Sales Team.profile-meta.xml');

      const delta = await ctx.repo.delta();
      const xml = await delta.packageFile('profiles/Sales Team.profile-meta.xml');

      expect(delta.package).to.deep.equal(['Profile:Sales Team']);
      expect(delta.destructive).to.deep.equal(['Profile:Sales']);
      expect(xml).to.contain('Invoice__c.Amount__c');
      expect(xml).to.contain('InvoicePdf');
    });
  });
});
