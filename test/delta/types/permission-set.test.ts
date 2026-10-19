import { expect } from 'chai';

import { useDeltaRepo } from '../helpers/delta-repo.js';
import {
  classAccess,
  fieldPermission,
  mutingPermissionSetXml,
  objectPermission,
  permissionSetGroupXml,
  permissionSetXml,
  userPermission,
} from '../helpers/metadata-xml.js';

// Deploying a permission set replaces it in the org (verified in a sandbox): a partial file would revoke every
// access it does not list, so permission sets, groups and muting permission sets are always shipped whole.

const PS = 'permissionsets/Invoicing.permissionset-meta.xml';
const PSG = 'permissionsetgroups/Finance.permissionsetgroup-meta.xml';
const MUTING = 'mutingpermissionsets/FinanceMuted.mutingpermissionset-meta.xml';

const items = [
  classAccess('InvoiceService'),
  fieldPermission('Invoice__c.Amount__c'),
  fieldPermission('Invoice__c.Status__c'),
  objectPermission('Invoice__c'),
  userPermission('ApiEnabled'),
];

describe('delta by type: PermissionSet, PermissionSetGroup, MutingPermissionSet', () => {
  const ctx = useDeltaRepo();

  describe('PermissionSet', () => {
    const changePermissionSet = async (
      after: string
    ): Promise<{ package: string[]; destructive: string[]; xml: string }> => {
      await ctx.repo.baseline({ [PS]: permissionSetXml('Invoicing', ...items) });
      await ctx.repo.write({ [PS]: after });
      const delta = await ctx.repo.delta();
      return {
        package: delta.package,
        destructive: delta.destructive,
        xml: await delta.packageFile(PS),
      };
    };

    it('ships a new permission set whole', async () => {
      await ctx.repo.baseline({
        'permissionsets/Other.permissionset-meta.xml': permissionSetXml('Other'),
      });
      await ctx.repo.write({ [PS]: permissionSetXml('Invoicing', ...items) });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['PermissionSet:Invoicing']);
      expect(await delta.packageFile(PS)).to.equal(permissionSetXml('Invoicing', ...items));
    });

    it('ships the whole file when one access changes', async () => {
      const after = permissionSetXml(
        'Invoicing',
        ...items.map((item) => item.replace('<editable>true', '<editable>false'))
      );
      const delta = await changePermissionSet(after);

      expect(delta.package).to.deep.equal(['PermissionSet:Invoicing']);
      expect(delta.xml).to.equal(after);
    });

    it('ships the whole file without the removed access, so the org revokes it', async () => {
      const after = permissionSetXml('Invoicing', ...items.filter((item) => !item.includes('Invoice__c.Status__c')));
      const delta = await changePermissionSet(after);

      expect(delta.xml).to.equal(after);
      expect(delta.xml).not.to.contain('Invoice__c.Status__c');
      expect(delta.destructive).to.deep.equal([]);
    });

    it('ships the whole file for a change of label or description', async () => {
      const after = permissionSetXml('Invoicing team', ...items);
      const delta = await changePermissionSet(after);

      expect(delta.xml).to.equal(after);
    });

    it('ships the whole file again for a pure reformatting (harmless, not minimal)', async () => {
      const after = permissionSetXml('Invoicing', ...items).replaceAll('\n', '\r\n');
      const delta = await changePermissionSet(after);

      expect(delta.package).to.deep.equal(['PermissionSet:Invoicing']);
    });

    it('lists a deleted permission set in destructiveChanges.xml', async () => {
      await ctx.repo.baseline({ [PS]: permissionSetXml('Invoicing', ...items) });
      await ctx.repo.remove(PS);

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal(['PermissionSet:Invoicing']);
      expect(delta.package).to.deep.equal([]);
    });

    it('turns a rename into a deleted permission set plus the new one', async () => {
      await ctx.repo.baseline({ [PS]: permissionSetXml('Invoicing', ...items) });
      ctx.repo.rename(PS, 'permissionsets/Billing.permissionset-meta.xml');

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['PermissionSet:Billing']);
      expect(delta.destructive).to.deep.equal(['PermissionSet:Invoicing']);
    });
  });

  describe('PermissionSetGroup', () => {
    it('ships a new group', async () => {
      await ctx.repo.baseline({ [PS]: permissionSetXml('Invoicing', ...items) });
      await ctx.repo.write({ [PSG]: permissionSetGroupXml('Finance', ['Invoicing']) });

      expect((await ctx.repo.delta()).package).to.deep.equal(['PermissionSetGroup:Finance']);
    });

    it('ships the whole group when a permission set is added or removed', async () => {
      await ctx.repo.baseline({
        [PSG]: permissionSetGroupXml('Finance', ['Invoicing', 'Payments']),
      });
      const after = permissionSetGroupXml('Finance', ['Invoicing', 'Reporting']);
      await ctx.repo.write({ [PSG]: after });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['PermissionSetGroup:Finance']);
      expect(await delta.packageFile(PSG)).to.equal(after);
    });

    it('ships the group with its new permission set in the same delta', async () => {
      await ctx.repo.baseline({ [PSG]: permissionSetGroupXml('Finance', ['Invoicing']) });
      await ctx.repo.write({
        'permissionsets/Payments.permissionset-meta.xml': permissionSetXml('Payments'),
        [PSG]: permissionSetGroupXml('Finance', ['Invoicing', 'Payments']),
      });

      expect((await ctx.repo.delta()).package).to.have.members([
        'PermissionSet:Payments',
        'PermissionSetGroup:Finance',
      ]);
    });

    it('lists a deleted group in destructiveChanges.xml', async () => {
      await ctx.repo.baseline({ [PSG]: permissionSetGroupXml('Finance', ['Invoicing']) });
      await ctx.repo.remove(PSG);

      expect((await ctx.repo.delta()).destructive).to.deep.equal(['PermissionSetGroup:Finance']);
    });
  });

  describe('MutingPermissionSet', () => {
    it('ships the whole muting permission set when it changes', async () => {
      await ctx.repo.baseline({
        [MUTING]: mutingPermissionSetXml('Finance muted', userPermission('ApiEnabled', false)),
      });
      const after = mutingPermissionSetXml(
        'Finance muted',
        userPermission('ApiEnabled', false),
        userPermission('ViewSetup', false)
      );
      await ctx.repo.write({ [MUTING]: after });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['MutingPermissionSet:FinanceMuted']);
      expect(await delta.packageFile(MUTING)).to.equal(after);
    });

    it('lists a deleted muting permission set in destructiveChanges.xml', async () => {
      await ctx.repo.baseline({ [MUTING]: mutingPermissionSetXml('Finance muted') });
      await ctx.repo.remove(MUTING);

      expect((await ctx.repo.delta()).destructive).to.deep.equal(['MutingPermissionSet:FinanceMuted']);
    });
  });
});
