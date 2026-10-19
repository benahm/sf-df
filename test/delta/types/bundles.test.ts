import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect } from 'chai';

import { useDeltaRepo } from '../helpers/delta-repo.js';
import { auraBundle, lwcBundle } from '../helpers/metadata-xml.js';

// LWC and Aura bundles are deployed as a whole folder: any change, including a deleted file, redeploys the bundle;
// only a bundle deleted entirely reaches destructiveChanges.xml.

const lwcFiles = (name: string): string[] => [
  `lwc/${name}/${name}.html`,
  `lwc/${name}/${name}.js`,
  `lwc/${name}/${name}.js-meta.xml`,
];
const auraFiles = (name: string): string[] =>
  [
    `aura/${name}/${name}.cmp`,
    `aura/${name}/${name}.cmp-meta.xml`,
    `aura/${name}/${name}Controller.js`,
    `aura/${name}/${name}Helper.js`,
  ].sort();

describe('delta by type: LightningComponentBundle and AuraDefinitionBundle', () => {
  const ctx = useDeltaRepo();

  describe('LWC', () => {
    it('ships a new bundle whole', async () => {
      await ctx.repo.baseline(lwcBundle('invoiceList'));
      await ctx.repo.write(lwcBundle('invoiceCard'));

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['LightningComponentBundle:invoiceCard']);
      expect(delta.packageFiles).to.deep.equal(lwcFiles('invoiceCard'));
    });

    it('ships the whole bundle when one file changes, and no other bundle', async () => {
      await ctx.repo.baseline({ ...lwcBundle('invoiceCard'), ...lwcBundle('invoiceList') });
      await ctx.repo.write({ 'lwc/invoiceCard/invoiceCard.html': '<template><p>Invoice</p></template>\n' });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['LightningComponentBundle:invoiceCard']);
      expect(delta.packageFiles).to.deep.equal(lwcFiles('invoiceCard'));
    });

    it('ships the bundle with a new CSS or helper file', async () => {
      await ctx.repo.baseline(lwcBundle('invoiceCard'));
      await ctx.repo.write({
        'lwc/invoiceCard/invoiceCard.css': ':host { display: block; }\n',
        'lwc/invoiceCard/format.js': 'export const format = (v) => v;\n',
      });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['LightningComponentBundle:invoiceCard']);
      expect(delta.packageFiles).to.include.members([
        'lwc/invoiceCard/invoiceCard.css',
        'lwc/invoiceCard/format.js',
        ...lwcFiles('invoiceCard'),
      ]);
    });

    it('redeploys the bundle without a deleted file', async () => {
      await ctx.repo.baseline({ ...lwcBundle('invoiceCard'), 'lwc/invoiceCard/invoiceCard.css': ':host {}\n' });
      await ctx.repo.remove('lwc/invoiceCard/invoiceCard.css');

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['LightningComponentBundle:invoiceCard']);
      expect(delta.packageFiles).to.deep.equal(lwcFiles('invoiceCard'));
      expect(delta.destructive).to.deep.equal([]);
    });

    const changeJestTest = async (forceIgnore?: string): Promise<string[]> => {
      if (forceIgnore) {
        await writeFile(path.join(ctx.repo.root, '.forceignore'), forceIgnore, 'utf8');
      }
      await ctx.repo.baseline({
        ...lwcBundle('invoiceCard'),
        'lwc/invoiceCard/__tests__/invoiceCard.test.js': "it('renders', () => {});\n",
      });
      await ctx.repo.write({
        'lwc/invoiceCard/__tests__/invoiceCard.test.js': "it('renders the amount', () => {});\n",
      });
      const delta = await ctx.repo.delta();
      expect(delta.packageFiles.filter((file) => file.includes('__tests__'))).to.deep.equal([]);
      expect(delta.destructive).to.deep.equal([]);
      return delta.package;
    };

    it('ships nothing when only a Jest test changes and .forceignore excludes __tests__ (default SFDX project)', async () => {
      expect(await changeJestTest('**/__tests__/**\n')).to.deep.equal([]);
    });

    it('redeploys the bundle without its Jest tests when .forceignore does not exclude them (not minimal)', async () => {
      expect(await changeJestTest()).to.deep.equal(['LightningComponentBundle:invoiceCard']);
    });

    it('lists a bundle deleted entirely', async () => {
      await ctx.repo.baseline({ ...lwcBundle('invoiceCard'), ...lwcBundle('invoiceList') });
      await ctx.repo.remove('lwc/invoiceCard');

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal(['LightningComponentBundle:invoiceCard']);
      expect(delta.package).to.deep.equal([]);
    });

    it('turns a renamed bundle into a deleted bundle plus the new one', async () => {
      await ctx.repo.baseline(lwcBundle('invoiceCard'));
      await ctx.repo.remove('lwc/invoiceCard');
      await ctx.repo.write(lwcBundle('billCard'));

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['LightningComponentBundle:billCard']);
      expect(delta.destructive).to.deep.equal(['LightningComponentBundle:invoiceCard']);
    });
  });

  describe('Aura', () => {
    it('ships a new bundle whole', async () => {
      await ctx.repo.baseline(auraBundle('InvoiceList'));
      await ctx.repo.write(auraBundle('InvoiceCard'));

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['AuraDefinitionBundle:InvoiceCard']);
      expect(delta.packageFiles).to.deep.equal(auraFiles('InvoiceCard'));
    });

    it('ships the whole bundle when its controller changes', async () => {
      await ctx.repo.baseline({ ...auraBundle('InvoiceCard'), ...auraBundle('InvoiceList') });
      await ctx.repo.write({
        'aura/InvoiceCard/InvoiceCardController.js': '({ init: function (cmp) { cmp.set("v.ready", true); } })\n',
      });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['AuraDefinitionBundle:InvoiceCard']);
      expect(delta.packageFiles).to.deep.equal(auraFiles('InvoiceCard'));
    });

    it('redeploys the bundle without a deleted helper', async () => {
      await ctx.repo.baseline(auraBundle('InvoiceCard'));
      await ctx.repo.remove('aura/InvoiceCard/InvoiceCardHelper.js');

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['AuraDefinitionBundle:InvoiceCard']);
      expect(delta.packageFiles).not.to.include('aura/InvoiceCard/InvoiceCardHelper.js');
      expect(delta.destructive).to.deep.equal([]);
    });

    it('lists a bundle deleted entirely', async () => {
      await ctx.repo.baseline({ ...auraBundle('InvoiceCard'), ...auraBundle('InvoiceList') });
      await ctx.repo.remove('aura/InvoiceCard');

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal(['AuraDefinitionBundle:InvoiceCard']);
      expect(delta.package).to.deep.equal([]);
    });
  });
});
