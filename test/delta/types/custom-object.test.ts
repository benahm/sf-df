import { expect } from 'chai';

import { useDeltaRepo } from '../helpers/delta-repo.js';
import {
  customObjectXml,
  metadataXml,
  numberFieldXml,
  picklistFieldXml,
  textFieldXml,
} from '../helpers/metadata-xml.js';

// CustomObject and CustomField: decomposed source, one component per file. A deleted object takes its children
// with it (verified in a sandbox, see src/delta/destructive-rules.ts).

const OBJECT = 'objects/Invoice__c/Invoice__c.object-meta.xml';
const field = (name: string, object = 'Invoice__c'): string => `objects/${object}/fields/${name}.field-meta.xml`;
const listView = 'objects/Invoice__c/listViews/All.listView-meta.xml';
const validationRule = 'objects/Invoice__c/validationRules/AmountPositive.validationRule-meta.xml';

const baselineFiles = {
  [OBJECT]: customObjectXml('Invoice'),
  [field('Amount__c')]: numberFieldXml('Amount__c', 'Amount'),
  [field('Status__c')]: picklistFieldXml('Status__c', ['Draft', 'Sent']),
  [field('Reference__c')]: textFieldXml('Reference__c'),
  [listView]: metadataXml(
    'ListView',
    '<fullName>All</fullName>',
    '<filterScope>Everything</filterScope>',
    '<label>All</label>'
  ),
  [validationRule]: metadataXml(
    'ValidationRule',
    '<fullName>AmountPositive</fullName>',
    '<active>true</active>',
    '<errorConditionFormula>Amount__c &lt; 0</errorConditionFormula>',
    '<errorMessage>Amount must be positive</errorMessage>'
  ),
};

describe('delta by type: CustomObject and CustomField', () => {
  const ctx = useDeltaRepo();

  describe('CustomObject', () => {
    it('ships a new object with each of its children', async () => {
      await ctx.repo.baseline({
        'objects/Other__c/Other__c.object-meta.xml': customObjectXml('Other'),
      });
      await ctx.repo.write(baselineFiles);

      const delta = await ctx.repo.delta();

      expect(delta.package).to.have.members([
        'CustomObject:Invoice__c',
        'CustomField:Invoice__c.Amount__c',
        'CustomField:Invoice__c.Status__c',
        'CustomField:Invoice__c.Reference__c',
        'ListView:Invoice__c.All',
        'ValidationRule:Invoice__c.AmountPositive',
      ]);
      expect(delta.destructive).to.deep.equal([]);
    });

    // SDR resolves the object file to the whole decomposed object; only the object file ships, since its fields,
    // list views and validation rules did not change and deploying an object never removes the children it omits.
    it('ships only the object file when only the object definition changes', async () => {
      await ctx.repo.baseline(baselineFiles);
      await ctx.repo.write({
        [OBJECT]: customObjectXml('Invoice', ['<enableHistory>true</enableHistory>']),
      });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['CustomObject:Invoice__c']);
      expect(delta.packageFiles).to.deep.equal([OBJECT]);
    });

    it('ships the object file and the changed field when both change', async () => {
      await ctx.repo.baseline(baselineFiles);
      await ctx.repo.write({
        [OBJECT]: customObjectXml('Invoice', ['<enableHistory>true</enableHistory>']),
        [field('Amount__c')]: numberFieldXml('Amount__c', 'Total'),
      });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.have.members(['CustomObject:Invoice__c', 'CustomField:Invoice__c.Amount__c']);
      expect(delta.packageFiles).to.have.members([OBJECT, field('Amount__c')]);
    });

    it('ships a changed list view or validation rule alone', async () => {
      await ctx.repo.baseline(baselineFiles);
      await ctx.repo.write({
        [validationRule]: baselineFiles[validationRule].replace('<active>true', '<active>false'),
      });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['ValidationRule:Invoice__c.AmountPositive']);
      expect(delta.packageFiles).to.deep.equal([validationRule]);
    });

    it('lists a deleted list view or validation rule alone while the object is kept', async () => {
      await ctx.repo.baseline(baselineFiles);
      await ctx.repo.remove(listView, validationRule);

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.have.members([
        'ListView:Invoice__c.All',
        'ValidationRule:Invoice__c.AmountPositive',
      ]);
      expect(delta.package).to.deep.equal([]);
    });

    it('lists only the deleted object, its children go with it', async () => {
      await ctx.repo.baseline(baselineFiles);
      await ctx.repo.remove('objects/Invoice__c');

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal(['CustomObject:Invoice__c']);
      expect(delta.package).to.deep.equal([]);
    });

    it('ships a custom metadata type, a platform event and their fields like a custom object', async () => {
      await ctx.repo.baseline({
        'objects/Other__c/Other__c.object-meta.xml': customObjectXml('Other'),
      });
      await ctx.repo.write({
        'objects/Setting__mdt/Setting__mdt.object-meta.xml': metadataXml(
          'CustomObject',
          '<label>Setting</label>',
          '<pluralLabel>Settings</pluralLabel>',
          '<visibility>Public</visibility>'
        ),
        [field('Value__c', 'Setting__mdt')]: textFieldXml('Value__c'),
        'objects/Paid__e/Paid__e.object-meta.xml': metadataXml(
          'CustomObject',
          '<deploymentStatus>Deployed</deploymentStatus>',
          '<eventType>HighVolume</eventType>',
          '<label>Paid</label>',
          '<pluralLabel>Paid</pluralLabel>',
          '<publishBehavior>PublishAfterCommit</publishBehavior>'
        ),
      });

      expect((await ctx.repo.delta()).package).to.have.members([
        'CustomObject:Setting__mdt',
        'CustomField:Setting__mdt.Value__c',
        'CustomObject:Paid__e',
      ]);
    });
  });

  describe('CustomField', () => {
    it('ships a new field alone', async () => {
      await ctx.repo.baseline(baselineFiles);
      await ctx.repo.write({ [field('Due__c')]: textFieldXml('Due__c') });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['CustomField:Invoice__c.Due__c']);
      expect(delta.packageFiles).to.deep.equal([field('Due__c')]);
    });

    it('ships a new field of a standard object', async () => {
      await ctx.repo.baseline({ [field('Segment__c', 'Account')]: textFieldXml('Segment__c') });
      await ctx.repo.write({ [field('Tier__c', 'Account')]: textFieldXml('Tier__c') });

      expect((await ctx.repo.delta()).package).to.deep.equal(['CustomField:Account.Tier__c']);
    });

    it('ships the whole field when its label, length or type changes', async () => {
      await ctx.repo.baseline(baselineFiles);
      const after = textFieldXml('Reference__c', 'Ref', 255);
      await ctx.repo.write({ [field('Reference__c')]: after });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['CustomField:Invoice__c.Reference__c']);
      expect(await delta.packageFile(field('Reference__c'))).to.equal(after);
    });

    it('ships the whole field when a picklist value is added or removed', async () => {
      await ctx.repo.baseline(baselineFiles);
      const after = picklistFieldXml('Status__c', ['Draft', 'Paid']);
      await ctx.repo.write({ [field('Status__c')]: after });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['CustomField:Invoice__c.Status__c']);
      expect(await delta.packageFile(field('Status__c'))).to.equal(after);
      expect(delta.destructive).to.deep.equal([]);
    });

    it('lists a deleted field in destructiveChanges.xml', async () => {
      await ctx.repo.baseline(baselineFiles);
      await ctx.repo.remove(field('Reference__c'));

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal(['CustomField:Invoice__c.Reference__c']);
      expect(delta.package).to.deep.equal([]);
    });

    it('turns a renamed field file into a deleted field plus a new one', async () => {
      await ctx.repo.baseline(baselineFiles);
      ctx.repo.rename(field('Reference__c'), field('Ref__c'));
      await ctx.repo.write({ [field('Ref__c')]: textFieldXml('Ref__c') });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['CustomField:Invoice__c.Ref__c']);
      expect(delta.destructive).to.deep.equal(['CustomField:Invoice__c.Reference__c']);
    });

    it('lists the deleted field and ships the profile that stopped referencing it', async () => {
      const profile = (fields: string[]): string =>
        metadataXml(
          'Profile',
          ...fields.map(
            (name) =>
              `<fieldPermissions><editable>true</editable><field>Invoice__c.${name}</field><readable>true</readable></fieldPermissions>`
          ),
          '<userPermissions><enabled>true</enabled><name>ApiEnabled</name></userPermissions>',
          '<custom>true</custom>',
          '<userLicense>Salesforce</userLicense>'
        );
      await ctx.repo.baseline({
        ...baselineFiles,
        'profiles/Sales.profile-meta.xml': profile(['Amount__c', 'Reference__c']),
      });
      await ctx.repo.remove(field('Reference__c'));
      await ctx.repo.write({ 'profiles/Sales.profile-meta.xml': profile(['Amount__c']) });

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal(['CustomField:Invoice__c.Reference__c']);
      // Removing the field permission alone changes nothing to deploy: the deleted field takes it with it.
      expect(delta.package).to.deep.equal([]);
    });
  });
});
