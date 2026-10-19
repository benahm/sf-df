import { expect } from 'chai';

import { useDeltaRepo } from '../helpers/delta-repo.js';
import { customObjectXml, recordTypeXml, type PicklistSelection } from '../helpers/metadata-xml.js';

// RecordType: partial XML with the singletons Salesforce requires, and deactivation instead of deletion.
// See docs/git-delta-metadata-strategies.md (RecordTypeStrategy).

const OBJECT = 'objects/Invoice__c/Invoice__c.object-meta.xml';
const rt = (name: string): string => `objects/Invoice__c/recordTypes/${name}.recordType-meta.xml`;
const status: PicklistSelection = {
  picklist: 'Status__c',
  values: ['Draft', 'Sent', 'Paid'],
  defaultValue: 'Draft',
};
const channel: PicklistSelection = { picklist: 'Channel__c', values: ['Web', 'Shop'] };

describe('delta by type: RecordType', () => {
  const ctx = useDeltaRepo();

  const baseline = (files: Record<string, string> = {}): Promise<string> =>
    ctx.repo.baseline({
      [OBJECT]: customObjectXml('Invoice'),
      [rt('B2B')]: recordTypeXml('B2B', { description: 'Companies', picklists: [status, channel] }),
      [rt('B2C')]: recordTypeXml('B2C'),
      ...files,
    });

  describe('additions', () => {
    it('ships a new record type whole', async () => {
      await baseline();
      const added = recordTypeXml('Partner', { picklists: [status] });
      await ctx.repo.write({ [rt('Partner')]: added });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['RecordType:Invoice__c.Partner']);
      expect(delta.packageFiles).to.deep.equal([rt('Partner')]);
      expect(await delta.packageFile(rt('Partner'))).to.contain('<picklist>Status__c</picklist>');
      expect(delta.destructive).to.deep.equal([]);
    });

    it('ships a new record type of an object that is new too', async () => {
      await ctx.repo.baseline({ 'classes/.keep': '' });
      await ctx.repo.write({
        [OBJECT]: customObjectXml('Invoice'),
        [rt('B2B')]: recordTypeXml('B2B'),
      });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.include.members(['CustomObject:Invoice__c', 'RecordType:Invoice__c.B2B']);
    });

    it('ships a record type of a standard object', async () => {
      const file = 'objects/Opportunity/recordTypes/Renewal.recordType-meta.xml';
      await ctx.repo.baseline({ [file]: recordTypeXml('Renewal', { businessProcess: 'Sales' }) });
      await ctx.repo.write({ [file]: recordTypeXml('Renewal', { businessProcess: 'Renewals' }) });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['RecordType:Opportunity.Renewal']);
      expect(await delta.packageFile(file)).to.contain('<businessProcess>Renewals</businessProcess>');
    });
  });

  describe('modifications', () => {
    it('ships only the changed label, with the required singletons', async () => {
      await baseline();
      await ctx.repo.write({
        [rt('B2B')]: recordTypeXml('B2B', {
          label: 'Business',
          description: 'Companies',
          picklists: [status, channel],
        }),
      });

      const delta = await ctx.repo.delta();
      const xml = await delta.packageFile(rt('B2B'));

      expect(delta.package).to.deep.equal(['RecordType:Invoice__c.B2B']);
      expect(xml).to.contain('<label>Business</label>');
      expect(xml).to.contain('<fullName>B2B</fullName>');
      expect(xml).to.contain('<active>true</active>');
      // Minimal delta: unchanged description and picklists stay out.
      expect(xml).not.to.contain('<description>');
      expect(xml).not.to.contain('<picklistValues>');
    });

    it('ships a changed description with the singletons', async () => {
      await baseline();
      await ctx.repo.write({
        [rt('B2B')]: recordTypeXml('B2B', {
          description: 'Companies and NGOs',
          picklists: [status, channel],
        }),
      });

      const xml = await (await ctx.repo.delta()).packageFile(rt('B2B'));

      expect(xml).to.contain('<description>Companies and NGOs</description>');
      expect(xml).to.contain('<label>B2B</label>');
      expect(xml).not.to.contain('<picklistValues>');
    });

    for (const [from, to] of [
      [true, false],
      [false, true],
    ] as const) {
      it(`ships active ${String(from)} -> ${String(to)}`, async () => {
        await ctx.repo.baseline({
          [OBJECT]: customObjectXml('Invoice'),
          [rt('B2C')]: recordTypeXml('B2C', { active: from }),
        });
        await ctx.repo.write({ [rt('B2C')]: recordTypeXml('B2C', { active: to }) });

        const delta = await ctx.repo.delta();

        expect(await delta.packageFile(rt('B2C'))).to.contain(`<active>${String(to)}</active>`);
        expect(delta.destructive).to.deep.equal([]);
      });
    }

    it('ships a changed compact layout assignment', async () => {
      await ctx.repo.baseline({
        [rt('B2C')]: recordTypeXml('B2C', { compactLayoutAssignment: 'Short' }),
      });
      await ctx.repo.write({
        [rt('B2C')]: recordTypeXml('B2C', { compactLayoutAssignment: 'Detailed' }),
      });

      expect(await (await ctx.repo.delta()).packageFile(rt('B2C'))).to.contain(
        '<compactLayoutAssignment>Detailed</compactLayoutAssignment>'
      );
    });

    it('ships a changed business process', async () => {
      const file = 'objects/Case/recordTypes/Support.recordType-meta.xml';
      await ctx.repo.baseline({
        [file]: recordTypeXml('Support', { businessProcess: 'Standard' }),
      });
      await ctx.repo.write({ [file]: recordTypeXml('Support', { businessProcess: 'Escalation' }) });

      expect(await (await ctx.repo.delta()).packageFile(file)).to.contain(
        '<businessProcess>Escalation</businessProcess>'
      );
    });
  });

  describe('picklist values', () => {
    // picklistValues has no key rule: as soon as one of them changes, every picklist of the record type is
    // shipped, so the deployed record type always carries the complete value list of each picklist. Verified in a
    // sandbox: a value missing from the list is removed from the record type, a picklist not shipped is untouched.
    const changePicklists = async (...picklists: PicklistSelection[]): Promise<string> => {
      await baseline();
      await ctx.repo.write({
        [rt('B2B')]: recordTypeXml('B2B', { description: 'Companies', picklists }),
      });
      const delta = await ctx.repo.delta();
      expect(delta.package).to.deep.equal(['RecordType:Invoice__c.B2B']);
      expect(delta.destructive).to.deep.equal([]);
      return delta.packageFile(rt('B2B'));
    };

    it('ships every picklist when a value is added to one of them', async () => {
      const xml = await changePicklists({ ...status, values: [...status.values, 'Cancelled'] }, channel);

      expect(xml).to.contain('<fullName>Cancelled</fullName>');
      expect(xml).to.contain('<fullName>Paid</fullName>');
      expect(xml).to.contain('<picklist>Channel__c</picklist>');
      expect(xml).to.contain('<label>B2B</label>');
    });

    it('ships the remaining values when a value is removed', async () => {
      const xml = await changePicklists({ ...status, values: ['Draft', 'Paid'] }, channel);

      expect(xml).to.contain('<fullName>Draft</fullName>');
      expect(xml).not.to.contain('<fullName>Sent</fullName>');
      expect(xml).to.contain('<picklist>Channel__c</picklist>');
    });

    it('ships a changed default value', async () => {
      const xml = await changePicklists({ ...status, defaultValue: 'Sent' }, channel);

      expect(xml).to.match(/<fullName>Sent<\/fullName>\s*<default>true<\/default>/);
      expect(xml).to.match(/<fullName>Draft<\/fullName>\s*<default>false<\/default>/);
    });

    it('ships a picklist newly made available on the record type', async () => {
      const xml = await changePicklists(status, channel, {
        picklist: 'Region__c',
        values: ['EMEA'],
      });

      expect(xml).to.contain('<picklist>Region__c</picklist>');
      expect(xml).to.contain('<picklist>Status__c</picklist>');
    });

    it('ships the other picklists when one picklist is removed from the record type', async () => {
      const xml = await changePicklists(status);

      expect(xml).to.contain('<picklist>Status__c</picklist>');
      expect(xml).not.to.contain('<picklist>Channel__c</picklist>');
    });

    it('ships the picklists again when their values are only reordered (harmless, not minimal)', async () => {
      const xml = await changePicklists({ ...status, values: ['Paid', 'Draft', 'Sent'] }, channel);

      expect(xml).to.contain('<picklist>Status__c</picklist>');
    });

    // Verified in a sandbox: deploying a record type without a picklistValues block keeps that picklist's values
    // in the org, even with the full file, so shipping nothing changes nothing.
    it('ships nothing when the last picklist is removed from the record type (the org keeps it anyway)', async () => {
      await ctx.repo.baseline({ [rt('B2C')]: recordTypeXml('B2C', { picklists: [channel] }) });
      await ctx.repo.write({ [rt('B2C')]: recordTypeXml('B2C') });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal([]);
      expect(delta.destructive).to.deep.equal([]);
    });
  });

  describe('no-op changes', () => {
    it('ships nothing for a pure reformatting', async () => {
      await baseline();
      const reformatted = recordTypeXml('B2B', {
        description: 'Companies',
        picklists: [status, channel],
      })
        .replaceAll('    <', '\t<')
        .replaceAll('\n', '\r\n');
      await ctx.repo.write({ [rt('B2B')]: reformatted });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal([]);
      expect(delta.packageFiles).to.deep.equal([]);
    });

    it('ships nothing when a record type is added then deleted inside the compared range', async () => {
      const from = await baseline();
      await ctx.repo.write({ [rt('Temp')]: recordTypeXml('Temp') });
      ctx.repo.commit('add');
      await ctx.repo.remove(rt('Temp'));
      const to = ctx.repo.commit('remove');

      const delta = await ctx.repo.delta({ from, to });

      expect(delta.package).to.deep.equal([]);
      expect(delta.destructive).to.deep.equal([]);
      expect(delta.warnings).to.equal('');
    });

    it('ships the difference only when a record type is deleted then recreated inside the range', async () => {
      const from = await baseline();
      await ctx.repo.remove(rt('B2C'));
      ctx.repo.commit('remove');
      await ctx.repo.write({ [rt('B2C')]: recordTypeXml('B2C', { label: 'Consumers' }) });
      const to = ctx.repo.commit('recreate');

      const delta = await ctx.repo.delta({ from, to });

      expect(delta.package).to.deep.equal(['RecordType:Invoice__c.B2C']);
      expect(await delta.packageFile(rt('B2C'))).to.contain('<label>Consumers</label>');
      expect(delta.warnings).not.to.contain('cannot be deleted');
    });
  });

  describe('deletions and renames', () => {
    it('deploys a deleted record type as inactive, never in destructiveChanges.xml', async () => {
      await baseline();
      await ctx.repo.remove(rt('B2B'));

      const delta = await ctx.repo.delta();
      const xml = await delta.packageFile(rt('B2B'));

      expect(delta.package).to.deep.equal(['RecordType:Invoice__c.B2B']);
      expect(xml).to.contain('<active>false</active>');
      // The whole deleted file is deployed so the deactivation carries a valid record type.
      expect(xml).to.contain('<label>B2B</label>');
      expect(xml).to.contain('<picklist>Status__c</picklist>');
      expect(delta.destructive).to.deep.equal([]);
      expect(delta.warnings).to.contain('RecordType:Invoice__c.B2B cannot be deleted');
    });

    // Verified in a sandbox: deactivating the default record type of a profile deploys.
    it('deactivates a deleted record type that is the default of a profile', async () => {
      await baseline({
        'profiles/Sales.profile-meta.xml': `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <recordTypeVisibilities><default>true</default><recordType>Invoice__c.B2B</recordType><visible>true</visible></recordTypeVisibilities>
    <custom>true</custom>
    <userLicense>Salesforce</userLicense>
</Profile>
`,
      });
      await ctx.repo.remove(rt('B2B'));

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['RecordType:Invoice__c.B2B']);
      expect(await delta.packageFile(rt('B2B'))).to.contain('<active>false</active>');
    });

    it('deactivates every deleted record type of an object that is kept', async () => {
      await baseline();
      await ctx.repo.remove(rt('B2B'), rt('B2C'));

      const delta = await ctx.repo.delta();

      expect(delta.package).to.have.members(['RecordType:Invoice__c.B2B', 'RecordType:Invoice__c.B2C']);
      expect(delta.destructive).to.deep.equal([]);
    });

    it('lets the record types go with their deleted object', async () => {
      await baseline();
      await ctx.repo.remove('objects/Invoice__c');

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal([]);
      expect(delta.destructive).to.deep.equal(['CustomObject:Invoice__c']);
    });

    it('turns a rename into the new record type plus the old one deactivated', async () => {
      await baseline();
      ctx.repo.rename(rt('B2C'), rt('Consumer'));
      await ctx.repo.write({ [rt('Consumer')]: recordTypeXml('Consumer') });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.have.members(['RecordType:Invoice__c.Consumer', 'RecordType:Invoice__c.B2C']);
      expect(await delta.packageFile(rt('Consumer'))).to.contain('<active>true</active>');
      expect(await delta.packageFile(rt('B2C'))).to.contain('<active>false</active>');
      expect(delta.destructive).to.deep.equal([]);
    });
  });
});
