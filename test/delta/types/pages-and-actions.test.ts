import { expect } from 'chai';

import { useDeltaRepo } from '../helpers/delta-repo.js';
import {
  businessProcessXml,
  compactLayoutXml,
  customObjectXml,
  fieldSetXml,
  flexiPageXml,
  layoutXml,
  quickActionXml,
  webLinkXml,
} from '../helpers/metadata-xml.js';

// Layout, FlexiPage, QuickAction and the small children of an object (compact layouts, buttons and links, field
// sets, business processes): one file per component, shipped whole, deleted by name.

const OBJECT = 'objects/Invoice__c/Invoice__c.object-meta.xml';
const LAYOUT = 'layouts/Invoice__c-Invoice Layout.layout-meta.xml';
const FLEXIPAGE = 'flexipages/Invoice_Record_Page.flexipage-meta.xml';
const OBJECT_ACTION = 'quickActions/Invoice__c.Send.quickAction-meta.xml';
const GLOBAL_ACTION = 'quickActions/LogCall.quickAction-meta.xml';

describe('delta by type: Layout, FlexiPage, QuickAction and object children', () => {
  const ctx = useDeltaRepo();

  describe('Layout', () => {
    it('ships a new layout, whose name holds a space', async () => {
      await ctx.repo.baseline({ [OBJECT]: customObjectXml('Invoice') });
      await ctx.repo.write({ [LAYOUT]: layoutXml('Name', 'Amount__c') });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['Layout:Invoice__c-Invoice Layout']);
      expect(delta.packageFiles).to.deep.equal([LAYOUT]);
    });

    it('ships the whole layout when a field is added or removed', async () => {
      await ctx.repo.baseline({ [LAYOUT]: layoutXml('Name', 'Amount__c', 'Status__c') });
      const after = layoutXml('Name', 'Status__c', 'Due__c');
      await ctx.repo.write({ [LAYOUT]: after });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['Layout:Invoice__c-Invoice Layout']);
      expect(await delta.packageFile(LAYOUT)).to.equal(after);
    });

    it('lists a deleted layout in destructiveChanges.xml', async () => {
      await ctx.repo.baseline({
        [LAYOUT]: layoutXml('Name'),
        'layouts/Invoice__c-Invoice B2B Layout.layout-meta.xml': layoutXml('Name'),
      });
      await ctx.repo.remove(LAYOUT);

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal(['Layout:Invoice__c-Invoice Layout']);
      expect(delta.package).to.deep.equal([]);
    });

    it('ships a layout of a standard object', async () => {
      const file = 'layouts/Account-Account Layout.layout-meta.xml';
      await ctx.repo.baseline({ [file]: layoutXml('Name') });
      await ctx.repo.write({ [file]: layoutXml('Name', 'Industry') });

      expect((await ctx.repo.delta()).package).to.deep.equal(['Layout:Account-Account Layout']);
    });
  });

  describe('FlexiPage', () => {
    it('ships a new or changed Lightning page whole', async () => {
      await ctx.repo.baseline({ [FLEXIPAGE]: flexiPageXml('Invoice Record Page') });
      const after = flexiPageXml('Invoice Record Page', 'flexipage:recordHomeTwoColEqualHeaderTemplateDesktop');
      await ctx.repo.write({ [FLEXIPAGE]: after });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['FlexiPage:Invoice_Record_Page']);
      expect(await delta.packageFile(FLEXIPAGE)).to.equal(after);
    });

    it('lists a deleted Lightning page in destructiveChanges.xml', async () => {
      await ctx.repo.baseline({
        [FLEXIPAGE]: flexiPageXml('Invoice Record Page'),
        'flexipages/Home.flexipage-meta.xml': flexiPageXml('Home'),
      });
      await ctx.repo.remove(FLEXIPAGE);

      expect((await ctx.repo.delta()).destructive).to.deep.equal(['FlexiPage:Invoice_Record_Page']);
    });
  });

  describe('QuickAction', () => {
    it('ships an object action and a global action under their own names', async () => {
      await ctx.repo.baseline({ [OBJECT]: customObjectXml('Invoice') });
      await ctx.repo.write({
        [OBJECT_ACTION]: quickActionXml('Send'),
        [GLOBAL_ACTION]: quickActionXml('Log a call', 'LogACall'),
      });

      expect((await ctx.repo.delta()).package).to.have.members(['QuickAction:Invoice__c.Send', 'QuickAction:LogCall']);
    });

    it('ships a changed action whole', async () => {
      await ctx.repo.baseline({ [OBJECT_ACTION]: quickActionXml('Send') });
      await ctx.repo.write({ [OBJECT_ACTION]: quickActionXml('Send invoice') });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['QuickAction:Invoice__c.Send']);
      expect(await delta.packageFile(OBJECT_ACTION)).to.contain('Send invoice');
    });

    it('lists a deleted action while its object is kept', async () => {
      await ctx.repo.baseline({ [OBJECT]: customObjectXml('Invoice'), [OBJECT_ACTION]: quickActionXml('Send') });
      await ctx.repo.remove(OBJECT_ACTION);

      expect((await ctx.repo.delta()).destructive).to.deep.equal(['QuickAction:Invoice__c.Send']);
    });

    it('still lists the action of a deleted object: Salesforce does not cascade it', async () => {
      await ctx.repo.baseline({ [OBJECT]: customObjectXml('Invoice'), [OBJECT_ACTION]: quickActionXml('Send') });
      await ctx.repo.remove('objects/Invoice__c', OBJECT_ACTION);

      expect((await ctx.repo.delta()).destructive).to.have.members([
        'CustomObject:Invoice__c',
        'QuickAction:Invoice__c.Send',
      ]);
    });
  });

  describe('object children', () => {
    const children: Array<{ type: string; file: string; before: string; after: string }> = [
      {
        type: 'CompactLayout:Invoice__c.Highlights',
        file: 'objects/Invoice__c/compactLayouts/Highlights.compactLayout-meta.xml',
        before: compactLayoutXml('Highlights', ['Name']),
        after: compactLayoutXml('Highlights', ['Name', 'Amount__c']),
      },
      {
        type: 'WebLink:Invoice__c.OpenPdf',
        file: 'objects/Invoice__c/webLinks/OpenPdf.webLink-meta.xml',
        before: webLinkXml('OpenPdf', '/apex/InvoicePdf'),
        after: webLinkXml('OpenPdf', '/apex/InvoicePdfV2'),
      },
      {
        type: 'FieldSet:Invoice__c.Summary',
        file: 'objects/Invoice__c/fieldSets/Summary.fieldSet-meta.xml',
        before: fieldSetXml('Summary', ['Name']),
        after: fieldSetXml('Summary', ['Name', 'Amount__c']),
      },
      {
        type: 'BusinessProcess:Opportunity.Renewal',
        file: 'objects/Opportunity/businessProcesses/Renewal.businessProcess-meta.xml',
        before: businessProcessXml('Renewal', ['Prospecting']),
        after: businessProcessXml('Renewal', ['Prospecting', 'Closed Won']),
      },
    ];

    for (const { type, file, before, after } of children) {
      it(`ships a changed ${type.split(':')[0]} alone, whole`, async () => {
        await ctx.repo.baseline({ [OBJECT]: customObjectXml('Invoice'), [file]: before });
        await ctx.repo.write({ [file]: after });

        const delta = await ctx.repo.delta();

        expect(delta.package).to.deep.equal([type]);
        expect(delta.packageFiles).to.deep.equal([file]);
        expect(await delta.packageFile(file)).to.equal(after);
      });

      it(`lists a deleted ${type.split(':')[0]} while its object is kept`, async () => {
        await ctx.repo.baseline({ [OBJECT]: customObjectXml('Invoice'), [file]: before });
        await ctx.repo.remove(file);

        const delta = await ctx.repo.delta();

        expect(delta.destructive).to.deep.equal([type]);
        expect(delta.package).to.deep.equal([]);
      });
    }
  });
});
