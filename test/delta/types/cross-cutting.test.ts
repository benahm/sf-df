import { expect } from 'chai';

import { useDeltaRepo } from '../helpers/delta-repo.js';
import { customObjectXml, textFieldXml } from '../helpers/metadata-xml.js';

// Behaviours shared by every metadata type.

const OBJECT = 'objects/Invoice__c/Invoice__c.object-meta.xml';
const FIELD = 'objects/Invoice__c/fields/Due__c.field-meta.xml';

describe('delta by type: cross-cutting', () => {
  const ctx = useDeltaRepo();

  // Known gap, to decide: against the working tree, the delta is `git diff HEAD`, which does not see files that
  // were never added to git. A new component must be staged (or committed) to be deployed.
  it('ignores a new file that is not added to git yet', async () => {
    await ctx.repo.baseline({ [OBJECT]: customObjectXml('Invoice') });
    await ctx.repo.write({ [FIELD]: textFieldXml('Due__c') });

    expect((await ctx.repo.delta({ stage: false })).package).to.deep.equal([]);
    expect((await ctx.repo.delta()).package).to.deep.equal(['CustomField:Invoice__c.Due__c']);
  });

  it('gives the same delta between two commits as against the staged working tree', async () => {
    const from = await ctx.repo.baseline({ [OBJECT]: customObjectXml('Invoice') });
    await ctx.repo.write({ [FIELD]: textFieldXml('Due__c') });

    const againstWorkspace = await ctx.repo.delta();
    const to = ctx.repo.commit('add field');
    const betweenCommits = await ctx.repo.delta({ from, to });

    expect(betweenCommits.package).to.deep.equal(againstWorkspace.package);
    expect(betweenCommits.packageFiles).to.deep.equal(againstWorkspace.packageFiles);
  });

  it('ships the net result of several commits', async () => {
    const from = await ctx.repo.baseline({ [OBJECT]: customObjectXml('Invoice') });
    await ctx.repo.write({ [FIELD]: textFieldXml('Due__c', 'Due') });
    ctx.repo.commit('add');
    await ctx.repo.write({ [FIELD]: textFieldXml('Due__c', 'Due date') });
    const to = ctx.repo.commit('relabel');

    const delta = await ctx.repo.delta({ from, to });

    expect(delta.package).to.deep.equal(['CustomField:Invoice__c.Due__c']);
    expect(await delta.packageFile(FIELD)).to.contain('<label>Due date</label>');
  });
});
