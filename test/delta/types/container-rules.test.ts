import { expect } from 'chai';

import { useDeltaRepo } from '../helpers/delta-repo.js';
import {
  customLabel,
  customLabelsXml,
  sharingCriteriaRule,
  sharingOwnerRule,
  sharingRulesXml,
  workflowAlert,
  workflowFieldUpdate,
  workflowRule,
  workflowXml,
} from '../helpers/metadata-xml.js';

// Containers whose children are described in the SDR registry: the package holds only the added or changed
// children, destructiveChanges.xml lists the deleted children by their own type, never the container.

const LABELS = 'labels/CustomLabels.labels-meta.xml';
const WORKFLOW = 'workflows/Invoice__c.workflow-meta.xml';
const SHARING = 'sharingRules/Invoice__c.sharingRules-meta.xml';

describe('delta by type: CustomLabels, Workflow, SharingRules', () => {
  const ctx = useDeltaRepo();

  describe('CustomLabels', () => {
    const base = [customLabel('Greeting', 'Hello'), customLabel('Farewell', 'Bye'), customLabel('Help', 'Help')];

    it('ships an added label alone', async () => {
      await ctx.repo.baseline({ [LABELS]: customLabelsXml(...base) });
      await ctx.repo.write({
        [LABELS]: customLabelsXml(...base, customLabel('Thanks', 'Thank you')),
      });

      const delta = await ctx.repo.delta();
      const xml = await delta.packageFile(LABELS);

      // The container is deployed with only the added or changed labels.
      expect(delta.package).to.deep.equal(['CustomLabels:CustomLabels']);
      expect(xml).to.contain('<fullName>Thanks</fullName>');
      expect(xml).not.to.contain('<fullName>Greeting</fullName>');
    });

    it('ships a changed value or a changed protected flag', async () => {
      await ctx.repo.baseline({ [LABELS]: customLabelsXml(...base) });
      await ctx.repo.write({
        [LABELS]: customLabelsXml(
          customLabel('Greeting', 'Hi'),
          customLabel('Farewell', 'Bye', true),
          customLabel('Help', 'Help')
        ),
      });

      const delta = await ctx.repo.delta();

      const xml = await delta.packageFile(LABELS);

      expect(delta.package).to.deep.equal(['CustomLabels:CustomLabels']);
      expect(xml).to.contain('<value>Hi</value>');
      expect(xml).to.contain('<fullName>Farewell</fullName>');
      expect(xml).not.to.contain('<fullName>Help</fullName>');
    });

    it('lists a deleted label by its own name', async () => {
      await ctx.repo.baseline({ [LABELS]: customLabelsXml(...base) });
      await ctx.repo.write({ [LABELS]: customLabelsXml(base[0], base[2]) });

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal(['CustomLabel:Farewell']);
      expect(delta.package).to.deep.equal([]);
    });

    it('ships the changed labels and lists the deleted ones in the same delta', async () => {
      await ctx.repo.baseline({ [LABELS]: customLabelsXml(...base) });
      await ctx.repo.write({
        [LABELS]: customLabelsXml(customLabel('Greeting', 'Hi'), base[2], customLabel('Thanks', 'Thank you')),
      });

      const delta = await ctx.repo.delta();

      const xml = await delta.packageFile(LABELS);

      expect(delta.package).to.deep.equal(['CustomLabels:CustomLabels']);
      expect(xml).to.contain('<fullName>Thanks</fullName>');
      expect(xml).not.to.contain('<fullName>Farewell</fullName>');
      expect(delta.destructive).to.deep.equal(['CustomLabel:Farewell']);
    });

    it('lists each label when the whole labels file is deleted', async () => {
      await ctx.repo.baseline({ [LABELS]: customLabelsXml(...base) });
      await ctx.repo.remove(LABELS);

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.have.members(['CustomLabel:Greeting', 'CustomLabel:Farewell', 'CustomLabel:Help']);
      expect(delta.destructive).not.to.include('CustomLabels:CustomLabels');
    });

    it('ships nothing when labels are only reordered or reformatted', async () => {
      await ctx.repo.baseline({ [LABELS]: customLabelsXml(...base) });
      await ctx.repo.write({
        [LABELS]: customLabelsXml(...[...base].reverse()).replaceAll('\n', '\r\n'),
      });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal([]);
      expect(delta.destructive).to.deep.equal([]);
    });
  });

  describe('Workflow', () => {
    const base = [
      workflowAlert('NotifyOwner', 'unfiled$public/Invoice'),
      workflowFieldUpdate('SetDescription', 'Sent'),
      workflowRule('OnCreate'),
      workflowRule('OnPaid', 'Paid__c'),
    ];

    it('ships only the changed rule', async () => {
      await ctx.repo.baseline({ [WORKFLOW]: workflowXml(...base) });
      await ctx.repo.write({
        [WORKFLOW]: workflowXml(...base.map((item) => item.replace('<formula>Paid__c', '<formula>NOT(Paid__c)'))),
      });

      const delta = await ctx.repo.delta();
      const xml = await delta.packageFile(WORKFLOW);

      expect(delta.package).to.deep.equal(['Workflow:Invoice__c']);
      expect(xml).to.contain('<fullName>OnPaid</fullName>');
      expect(xml).not.to.contain('<fullName>OnCreate</fullName>');
      expect(xml).not.to.contain('<fullName>SetDescription</fullName>');
    });

    it('ships an added field update without the rules', async () => {
      await ctx.repo.baseline({ [WORKFLOW]: workflowXml(...base) });
      await ctx.repo.write({
        [WORKFLOW]: workflowXml(...base, workflowFieldUpdate('SetPaid', 'Paid')),
      });

      const xml = await (await ctx.repo.delta()).packageFile(WORKFLOW);

      expect(xml).to.contain('<fullName>SetPaid</fullName>');
      expect(xml).not.to.contain('<rules>');
    });

    it('lists deleted rules, field updates and alerts by their own type', async () => {
      await ctx.repo.baseline({ [WORKFLOW]: workflowXml(...base) });
      await ctx.repo.write({ [WORKFLOW]: workflowXml(workflowRule('OnCreate')) });

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.have.members([
        'WorkflowAlert:Invoice__c.NotifyOwner',
        'WorkflowFieldUpdate:Invoice__c.SetDescription',
        'WorkflowRule:Invoice__c.OnPaid',
      ]);
      expect(delta.destructive).not.to.include('Workflow:Invoice__c');
    });

    it('lists each child when the whole workflow file is deleted while the object is kept', async () => {
      await ctx.repo.baseline({ [WORKFLOW]: workflowXml(...base) });
      await ctx.repo.remove(WORKFLOW);

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.include.members([
        'WorkflowRule:Invoice__c.OnCreate',
        'WorkflowRule:Invoice__c.OnPaid',
      ]);
      expect(delta.destructive).not.to.include('Workflow:Invoice__c');
    });
  });

  describe('SharingRules', () => {
    const base = [
      sharingCriteriaRule('ReadAll'),
      sharingCriteriaRule('EditSome', 'Edit'),
      sharingOwnerRule('FromSales'),
    ];

    it('ships only the changed rule, across rule kinds', async () => {
      await ctx.repo.baseline({ [SHARING]: sharingRulesXml(...base) });
      await ctx.repo.write({
        [SHARING]: sharingRulesXml(
          sharingCriteriaRule('ReadAll'),
          sharingCriteriaRule('EditSome', 'Read'),
          sharingOwnerRule('FromSales', 'Edit')
        ),
      });

      const xml = await (await ctx.repo.delta()).packageFile(SHARING);

      expect(xml).to.contain('<fullName>EditSome</fullName>');
      expect(xml).to.contain('<fullName>FromSales</fullName>');
      expect(xml).not.to.contain('<fullName>ReadAll</fullName>');
    });

    it('lists deleted criteria and owner rules by their own type', async () => {
      await ctx.repo.baseline({ [SHARING]: sharingRulesXml(...base) });
      await ctx.repo.write({ [SHARING]: sharingRulesXml(sharingCriteriaRule('ReadAll')) });

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.have.members([
        'SharingCriteriaRule:Invoice__c.EditSome',
        'SharingOwnerRule:Invoice__c.FromSales',
      ]);
      expect(delta.package).to.deep.equal([]);
    });

    it('ships nothing for a pure reformatting', async () => {
      await ctx.repo.baseline({ [SHARING]: sharingRulesXml(...base) });
      await ctx.repo.write({ [SHARING]: sharingRulesXml(...base).replaceAll('\n', '\r\n') });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal([]);
      expect(delta.destructive).to.deep.equal([]);
    });
  });
});
