import { expect } from 'chai';

import { useDeltaRepo } from '../helpers/delta-repo.js';
import {
  element,
  fieldTranslationXml,
  labelTranslation,
  objectTranslationXml,
  translationsXml,
} from '../helpers/metadata-xml.js';

// Translations (one file per language) are diffed by item and never deleted; object translations are decomposed
// into one file per field, and Salesforce requires the parent .objectTranslation in the deployment.

const FR = 'translations/fr.translation-meta.xml';
const OT_DIR = 'objectTranslations/Invoice__c-fr';
const OT = `${OT_DIR}/Invoice__c-fr.objectTranslation-meta.xml`;
const ft = (name: string): string => `${OT_DIR}/${name}.fieldTranslation-meta.xml`;

const tab = (name: string, label: string): string => element('customTabs', { label, name });
const app = (name: string, label: string): string => element('customApplications', { label, name });

describe('delta by type: Translations and CustomObjectTranslation', () => {
  const ctx = useDeltaRepo();

  describe('Translations', () => {
    const base = [
      app('Billing', 'Facturation'),
      labelTranslation('Greeting', 'Bonjour'),
      labelTranslation('Farewell', 'Au revoir'),
      tab('Invoice__c', 'Factures'),
    ];

    const changeTranslations = async (
      items: string[]
    ): Promise<{ package: string[]; destructive: string[]; xml: string }> => {
      await ctx.repo.baseline({ [FR]: translationsXml(...base) });
      await ctx.repo.write({ [FR]: translationsXml(...items) });
      const delta = await ctx.repo.delta();
      return {
        package: delta.package,
        destructive: delta.destructive,
        xml: await delta.packageFile(FR),
      };
    };

    it('ships a new language whole', async () => {
      await ctx.repo.baseline({
        'translations/de.translation-meta.xml': translationsXml(labelTranslation('Greeting', 'Hallo')),
      });
      await ctx.repo.write({ [FR]: translationsXml(...base) });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['Translations:fr']);
      expect(await delta.packageFile(FR)).to.contain('Au revoir');
    });

    it('ships only the changed label translation', async () => {
      const delta = await changeTranslations(base.map((item) => item.replace('Bonjour', 'Salut')));

      expect(delta.package).to.deep.equal(['Translations:fr']);
      expect(delta.xml).to.contain('<label>Salut</label>');
      expect(delta.xml).not.to.contain('Au revoir');
      expect(delta.xml).not.to.contain('Facturation');
    });

    it('ships only the added items of each section', async () => {
      const delta = await changeTranslations([...base, tab('Payment__c', 'Paiements'), app('Payments', 'Paiements')]);

      expect(delta.xml).to.contain('<name>Payment__c</name>');
      expect(delta.xml).to.contain('<name>Payments</name>');
      expect(delta.xml).not.to.contain('<name>Invoice__c</name>');
      expect(delta.xml).not.to.contain('<name>Billing</name>');
    });

    it('ships nothing for a removed translation: it goes away with the component it translates', async () => {
      await ctx.repo.baseline({ [FR]: translationsXml(...base) });
      await ctx.repo.write({
        [FR]: translationsXml(...base.filter((item) => !item.includes('Farewell'))),
      });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal([]);
      expect(delta.destructive).to.deep.equal([]);
    });

    it('ships nothing for a pure reformatting', async () => {
      await ctx.repo.baseline({ [FR]: translationsXml(...base) });
      await ctx.repo.write({
        [FR]: translationsXml(...base)
          .replaceAll('\n', '\r\n')
          .replaceAll('    <', '\t<'),
      });

      expect((await ctx.repo.delta()).package).to.deep.equal([]);
    });

    it('ships the label and its translation together', async () => {
      const labels = (value: string): string =>
        `<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n    <labels><fullName>Greeting</fullName><language>en_US</language><protected>false</protected><shortDescription>Greeting</shortDescription><value>${value}</value></labels>\n</CustomLabels>\n`;
      await ctx.repo.baseline({
        'labels/CustomLabels.labels-meta.xml': labels('Hello'),
        [FR]: translationsXml(...base),
      });
      await ctx.repo.write({
        'labels/CustomLabels.labels-meta.xml': labels('Hi'),
        [FR]: translationsXml(...base.map((item) => item.replace('Bonjour', 'Salut'))),
      });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.have.members(['CustomLabels:CustomLabels', 'Translations:fr']);
    });

    it('never deletes a language whose file is deleted', async () => {
      await ctx.repo.baseline({ [FR]: translationsXml(...base) });
      await ctx.repo.remove(FR);

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal([]);
      expect(delta.package).to.deep.equal([]);
      expect(delta.warnings).to.contain('Translations:fr is never deleted');
    });
  });

  describe('CustomObjectTranslation', () => {
    const baseFiles = {
      [OT]: objectTranslationXml('Facture'),
      [ft('Amount__c')]: fieldTranslationXml('Amount__c', 'Montant'),
      [ft('Status__c')]: fieldTranslationXml('Status__c', 'Statut'),
    };

    it('ships a changed field translation with its parent object translation', async () => {
      await ctx.repo.baseline(baseFiles);
      await ctx.repo.write({ [ft('Amount__c')]: fieldTranslationXml('Amount__c', 'Montant TTC') });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['CustomObjectTranslation:Invoice__c-fr']);
      expect(delta.packageFiles).to.have.members([OT, ft('Amount__c')]);
      expect(await delta.packageFile(ft('Amount__c'))).to.contain('Montant TTC');
    });

    it('ships a new field translation with its parent object translation', async () => {
      await ctx.repo.baseline(baseFiles);
      await ctx.repo.write({ [ft('Due__c')]: fieldTranslationXml('Due__c', 'Échéance') });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['CustomObjectTranslation:Invoice__c-fr']);
      expect(delta.packageFiles).to.have.members([OT, ft('Due__c')]);
    });

    it('ships the changed field translations of one object translation with their parent', async () => {
      await ctx.repo.baseline(baseFiles);
      await ctx.repo.write({
        [ft('Amount__c')]: fieldTranslationXml('Amount__c', 'Montant TTC'),
        [ft('Status__c')]: fieldTranslationXml('Status__c', 'État'),
      });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['CustomObjectTranslation:Invoice__c-fr']);
      expect(delta.packageFiles).to.have.members([OT, ft('Amount__c'), ft('Status__c')]);
    });

    // Deploying an object translation never removes the field translations it does not carry (see
    // test/e2e-org/metadata-lifecycle.org.e2e.test.ts), so the unchanged ones stay out.
    it('ships only the changed object translation file, without its field translations', async () => {
      await ctx.repo.baseline(baseFiles);
      await ctx.repo.write({ [OT]: objectTranslationXml('Facture client') });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['CustomObjectTranslation:Invoice__c-fr']);
      expect(delta.packageFiles).to.deep.equal([OT]);
      expect(await delta.packageFile(OT)).to.contain('Facture client');
    });

    it('ships a new language of an object translation', async () => {
      await ctx.repo.baseline(baseFiles);
      await ctx.repo.write({
        'objectTranslations/Invoice__c-de/Invoice__c-de.objectTranslation-meta.xml': objectTranslationXml('Rechnung'),
        'objectTranslations/Invoice__c-de/Amount__c.fieldTranslation-meta.xml': fieldTranslationXml(
          'Amount__c',
          'Betrag'
        ),
      });

      expect((await ctx.repo.delta()).package).to.deep.equal(['CustomObjectTranslation:Invoice__c-de']);
    });

    it('only warns when one field translation file is deleted', async () => {
      await ctx.repo.baseline(baseFiles);
      await ctx.repo.remove(ft('Status__c'));

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal([]);
      expect(delta.warnings).to.contain('belongs to CustomObjectTranslation:Invoice__c-fr');
    });

    it('lists the object translation of a language whose whole folder is deleted', async () => {
      await ctx.repo.baseline(baseFiles);
      await ctx.repo.remove(OT_DIR);

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal(['CustomObjectTranslation:Invoice__c-fr']);
      expect(delta.package).to.deep.equal([]);
    });
  });
});
