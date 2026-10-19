import { expect } from 'chai';

import { useDeltaRepo } from '../helpers/delta-repo.js';
import { apexClass, apexMetaXml, apexTrigger } from '../helpers/metadata-xml.js';

// ApexClass and ApexTrigger: a source file and its -meta.xml form one component, always shipped together.

describe('delta by type: ApexClass and ApexTrigger', () => {
  const ctx = useDeltaRepo();

  describe('ApexClass', () => {
    it('ships a new class with its meta file', async () => {
      await ctx.repo.baseline(apexClass('Existing'));
      await ctx.repo.write(apexClass('InvoiceService'));

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['ApexClass:InvoiceService']);
      expect(delta.packageFiles).to.deep.equal(['classes/InvoiceService.cls', 'classes/InvoiceService.cls-meta.xml']);
    });

    it('ships the class and its meta file when only the body changes', async () => {
      await ctx.repo.baseline({ ...apexClass('InvoiceService'), ...apexClass('Other') });
      await ctx.repo.write(apexClass('InvoiceService', ' public void send() {} '));

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['ApexClass:InvoiceService']);
      expect(delta.packageFiles).to.deep.equal(['classes/InvoiceService.cls', 'classes/InvoiceService.cls-meta.xml']);
      expect(await delta.packageFile('classes/InvoiceService.cls')).to.contain('send()');
    });

    it('ships the class body when only its API version changes', async () => {
      await ctx.repo.baseline(apexClass('InvoiceService'));
      await ctx.repo.write({ 'classes/InvoiceService.cls-meta.xml': apexMetaXml('ApexClass', '63.0') });

      const delta = await ctx.repo.delta();

      expect(delta.packageFiles).to.deep.equal(['classes/InvoiceService.cls', 'classes/InvoiceService.cls-meta.xml']);
      expect(await delta.packageFile('classes/InvoiceService.cls-meta.xml')).to.contain('63.0');
    });

    it('lists a deleted class once, whether one or both of its files are deleted', async () => {
      await ctx.repo.baseline(apexClass('InvoiceService'));
      await ctx.repo.remove('classes/InvoiceService.cls', 'classes/InvoiceService.cls-meta.xml');

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal(['ApexClass:InvoiceService']);
      expect(delta.package).to.deep.equal([]);
    });

    it('turns a rename into a deleted class plus the new one', async () => {
      await ctx.repo.baseline(apexClass('InvoiceService'));
      ctx.repo.rename('classes/InvoiceService.cls', 'classes/BillingService.cls');
      ctx.repo.rename('classes/InvoiceService.cls-meta.xml', 'classes/BillingService.cls-meta.xml');
      await ctx.repo.write({ 'classes/BillingService.cls': 'public with sharing class BillingService {}\n' });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['ApexClass:BillingService']);
      expect(delta.destructive).to.deep.equal(['ApexClass:InvoiceService']);
      expect(delta.packageFiles).to.deep.equal(['classes/BillingService.cls', 'classes/BillingService.cls-meta.xml']);
    });

    it('ships a test class like any other class', async () => {
      await ctx.repo.baseline(apexClass('InvoiceService'));
      await ctx.repo.write(apexClass('InvoiceServiceTest', ' @IsTest static void sends() {} '));

      expect((await ctx.repo.delta()).package).to.deep.equal(['ApexClass:InvoiceServiceTest']);
    });

    it('ships a class whose source only changes in line endings (not minimal: git sees a change)', async () => {
      await ctx.repo.baseline(apexClass('InvoiceService', '\n  public void send() {}\n'));
      await ctx.repo.write({
        'classes/InvoiceService.cls': apexClass('InvoiceService', '\n  public void send() {}\n')[
          'classes/InvoiceService.cls'
        ].replaceAll('\n', '\r\n'),
      });

      expect((await ctx.repo.delta()).package).to.deep.equal(['ApexClass:InvoiceService']);
    });
  });

  describe('ApexTrigger', () => {
    it('ships a new trigger with its meta file', async () => {
      await ctx.repo.baseline(apexClass('InvoiceService'));
      await ctx.repo.write(apexTrigger('InvoiceTrigger', 'Invoice__c'));

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['ApexTrigger:InvoiceTrigger']);
      expect(delta.packageFiles).to.deep.equal([
        'triggers/InvoiceTrigger.trigger',
        'triggers/InvoiceTrigger.trigger-meta.xml',
      ]);
    });

    it('ships a changed trigger with its meta file', async () => {
      await ctx.repo.baseline(apexTrigger('InvoiceTrigger', 'Invoice__c'));
      await ctx.repo.write(apexTrigger('InvoiceTrigger', 'Invoice__c', ' InvoiceService.send(); '));

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['ApexTrigger:InvoiceTrigger']);
      expect(delta.packageFiles).to.have.length(2);
    });

    it('ships a trigger deactivated through its meta file', async () => {
      await ctx.repo.baseline(apexTrigger('InvoiceTrigger', 'Invoice__c'));
      await ctx.repo.write({
        'triggers/InvoiceTrigger.trigger-meta.xml': apexMetaXml('ApexTrigger').replace('Active', 'Inactive'),
      });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['ApexTrigger:InvoiceTrigger']);
      expect(await delta.packageFile('triggers/InvoiceTrigger.trigger-meta.xml')).to.contain(
        '<status>Inactive</status>'
      );
    });

    it('lists a deleted trigger in destructiveChanges.xml', async () => {
      await ctx.repo.baseline(apexTrigger('InvoiceTrigger', 'Invoice__c'));
      await ctx.repo.remove('triggers/InvoiceTrigger.trigger', 'triggers/InvoiceTrigger.trigger-meta.xml');

      expect((await ctx.repo.delta()).destructive).to.deep.equal(['ApexTrigger:InvoiceTrigger']);
    });
  });

  it('ships the new class and lists the deleted one in the same delta', async () => {
    await ctx.repo.baseline({ ...apexClass('OldService'), ...apexTrigger('InvoiceTrigger', 'Invoice__c') });
    await ctx.repo.remove('classes/OldService.cls', 'classes/OldService.cls-meta.xml');
    await ctx.repo.write({
      ...apexClass('NewService'),
      ...apexTrigger('InvoiceTrigger', 'Invoice__c', ' NewService.run(); '),
    });

    const delta = await ctx.repo.delta();

    expect(delta.package).to.have.members(['ApexClass:NewService', 'ApexTrigger:InvoiceTrigger']);
    expect(delta.destructive).to.deep.equal(['ApexClass:OldService']);
  });
});
