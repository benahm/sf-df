import { expect } from 'chai';

import { useDeltaRepo } from '../helpers/delta-repo.js';
import { flowXml } from '../helpers/metadata-xml.js';

// Flow: shipped whole; a deleted flow is deactivated through its FlowDefinition (a flow cannot be deleted by name).

const FLOW = 'flows/Invoice_Sent.flow-meta.xml';
const definition = (name: string): string => `flowDefinitions/${name}.flowDefinition-meta.xml`;

describe('delta by type: Flow', () => {
  const ctx = useDeltaRepo();

  it('ships a new flow whole', async () => {
    await ctx.repo.baseline({ 'flows/Other.flow-meta.xml': flowXml('Other') });
    await ctx.repo.write({ [FLOW]: flowXml('Invoice sent') });

    const delta = await ctx.repo.delta();

    expect(delta.package).to.deep.equal(['Flow:Invoice_Sent']);
    expect(await delta.packageFile(FLOW)).to.equal(flowXml('Invoice sent'));
  });

  it('ships the whole flow when it changes, which creates a new version in the org', async () => {
    await ctx.repo.baseline({ [FLOW]: flowXml('Invoice sent') });
    await ctx.repo.write({ [FLOW]: flowXml('Invoice sent', 'Active', 'Notifies the customer') });

    const delta = await ctx.repo.delta();

    expect(delta.package).to.deep.equal(['Flow:Invoice_Sent']);
    expect(await delta.packageFile(FLOW)).to.contain('Notifies the customer');
  });

  for (const [from, to] of [
    ['Active', 'Draft'],
    ['Draft', 'Active'],
    ['Active', 'Obsolete'],
  ] as const) {
    it(`ships a flow whose status changes from ${from} to ${to}`, async () => {
      await ctx.repo.baseline({ [FLOW]: flowXml('Invoice sent', from) });
      await ctx.repo.write({ [FLOW]: flowXml('Invoice sent', to) });

      const delta = await ctx.repo.delta();

      expect(delta.package).to.deep.equal(['Flow:Invoice_Sent']);
      expect(await delta.packageFile(FLOW)).to.contain(`<status>${to}</status>`);
      expect(delta.destructive).to.deep.equal([]);
    });
  }

  it('deactivates a deleted flow through its FlowDefinition', async () => {
    await ctx.repo.baseline({ [FLOW]: flowXml('Invoice sent') });
    await ctx.repo.remove(FLOW);

    const delta = await ctx.repo.delta();

    expect(delta.package).to.deep.equal(['FlowDefinition:Invoice_Sent']);
    expect(await delta.packageFile(definition('Invoice_Sent'))).to.contain(
      '<activeVersionNumber>0</activeVersionNumber>'
    );
    expect(delta.destructive).to.deep.equal([]);
    expect(delta.warnings).to.contain('Flow:Invoice_Sent cannot be deleted by name');
  });

  it('turns a rename into the new flow plus the old one deactivated', async () => {
    await ctx.repo.baseline({ [FLOW]: flowXml('Invoice sent') });
    ctx.repo.rename(FLOW, 'flows/Invoice_Notified.flow-meta.xml');

    const delta = await ctx.repo.delta();

    expect(delta.package).to.have.members(['Flow:Invoice_Notified', 'FlowDefinition:Invoice_Sent']);
    expect(delta.destructive).to.deep.equal([]);
  });

  it('ships the whole flow again for a pure reformatting (harmless, but a new version)', async () => {
    await ctx.repo.baseline({ [FLOW]: flowXml('Invoice sent') });
    await ctx.repo.write({ [FLOW]: flowXml('Invoice sent').replaceAll('\n', '\r\n') });

    expect((await ctx.repo.delta()).package).to.deep.equal(['Flow:Invoice_Sent']);
  });

  it('ships nothing when a flow is added then deleted inside the compared range', async () => {
    const from = await ctx.repo.baseline({ 'flows/Other.flow-meta.xml': flowXml('Other') });
    await ctx.repo.write({ [FLOW]: flowXml('Invoice sent') });
    ctx.repo.commit('add');
    await ctx.repo.remove(FLOW);
    const to = ctx.repo.commit('remove');

    const delta = await ctx.repo.delta({ from, to });

    expect(delta.package).to.deep.equal([]);
    expect(delta.warnings).to.equal('');
  });
});
