import { expect } from 'chai';

import { useDeltaRepo } from '../helpers/delta-repo.js';
import { customMetadataRecordXml, globalValueSetXml, standardValueSetXml } from '../helpers/metadata-xml.js';

// Custom metadata records and value sets: one file per component, shipped whole.

const record = (name: string): string => `customMetadata/Setting.${name}.md-meta.xml`;
const GVS = 'globalValueSets/Countries.globalValueSet-meta.xml';
const SVS = 'standardValueSets/LeadSource.standardValueSet-meta.xml';

describe('delta by type: CustomMetadata records, GlobalValueSet, StandardValueSet', () => {
  const ctx = useDeltaRepo();

  describe('CustomMetadata records', () => {
    it('ships a new record', async () => {
      await ctx.repo.baseline({ [record('Default')]: customMetadataRecordXml('Default', [['Value__c', 'A']]) });
      await ctx.repo.write({ [record('Premium')]: customMetadataRecordXml('Premium', [['Value__c', 'B']]) });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['CustomMetadata:Setting.Premium']);
      expect(delta.packageFiles).to.deep.equal([record('Premium')]);
    });

    it('ships a record whose value changes, and no other record', async () => {
      await ctx.repo.baseline({
        [record('Default')]: customMetadataRecordXml('Default', [['Value__c', 'A']]),
        [record('Premium')]: customMetadataRecordXml('Premium', [['Value__c', 'B']]),
      });
      await ctx.repo.write({ [record('Default')]: customMetadataRecordXml('Default', [['Value__c', 'C']]) });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['CustomMetadata:Setting.Default']);
      expect(await delta.packageFile(record('Default'))).to.contain('>C</value>');
    });

    it('lists a deleted record in destructiveChanges.xml', async () => {
      await ctx.repo.baseline({ [record('Default')]: customMetadataRecordXml('Default', [['Value__c', 'A']]) });
      await ctx.repo.remove(record('Default'));

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal(['CustomMetadata:Setting.Default']);
      expect(delta.package).to.deep.equal([]);
    });

    it('turns a renamed record into a deleted record plus the new one', async () => {
      await ctx.repo.baseline({ [record('Default')]: customMetadataRecordXml('Default', [['Value__c', 'A']]) });
      ctx.repo.rename(record('Default'), record('Standard'));

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['CustomMetadata:Setting.Standard']);
      expect(delta.destructive).to.deep.equal(['CustomMetadata:Setting.Default']);
    });
  });

  describe('GlobalValueSet', () => {
    it('ships the whole value set when a value is added or removed', async () => {
      await ctx.repo.baseline({ [GVS]: globalValueSetXml('Countries', ['France', 'Spain']) });
      const after = globalValueSetXml('Countries', ['France', 'Italy']);
      await ctx.repo.write({ [GVS]: after });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['GlobalValueSet:Countries']);
      expect(await delta.packageFile(GVS)).to.equal(after);
      expect(delta.destructive).to.deep.equal([]);
    });

    // A value set still used by a field (even one in the recycle bin) cannot be deleted: the deployment fails and
    // the deletion has to wait for the field to be purged (see docs/git-delta-metadata-strategies.md).
    it('lists a deleted value set in destructiveChanges.xml', async () => {
      await ctx.repo.baseline({ [GVS]: globalValueSetXml('Countries', ['France']) });
      await ctx.repo.remove(GVS);

      expect((await ctx.repo.delta()).destructive).to.deep.equal(['GlobalValueSet:Countries']);
    });
  });

  describe('StandardValueSet', () => {
    it('ships the whole standard value set when a value changes', async () => {
      await ctx.repo.baseline({ [SVS]: standardValueSetXml(['Web', 'Phone Inquiry']) });
      const after = standardValueSetXml(['Web', 'Phone Inquiry', 'Partner Referral']);
      await ctx.repo.write({ [SVS]: after });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['StandardValueSet:LeadSource']);
      expect(await delta.packageFile(SVS)).to.equal(after);
    });

    // Verified in a sandbox: "The StandardValueSet called 'LeadSource' is standard and cannot be deleted".
    it('never lists a deleted standard value set in destructiveChanges.xml, and warns', async () => {
      await ctx.repo.baseline({ [SVS]: standardValueSetXml(['Web']) });
      await ctx.repo.remove(SVS);

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal([]);
      expect(delta.package).to.deep.equal([]);
      expect(delta.warnings).to.contain('StandardValueSet:LeadSource cannot be deleted');
    });
  });
});
