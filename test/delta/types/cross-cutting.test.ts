import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect } from 'chai';

import { FolderDeltaRepo, GitDeltaRepo, useDeltaRepo, type DeltaOutput, type DeltaRepo } from '../helpers/delta-repo.js';
import { apexMetaXml, customObjectXml, lwcBundle, textFieldXml } from '../helpers/metadata-xml.js';

// Behaviours shared by every metadata type.

const OBJECT = 'objects/Invoice__c/Invoice__c.object-meta.xml';
const FIELD = 'objects/Invoice__c/fields/Due__c.field-meta.xml';

describe('delta by type: cross-cutting', () => {
  // Untracked and ignored files, staging and commit ranges are git behaviours: a real repository.
  const ctx = useDeltaRepo({ git: true });

  // Against the working tree, the delta is what is on disk, like `sf project deploy start`: `git diff HEAD` alone
  // would miss files that were never added to git.
  it('ships a new file that is not added to git yet', async () => {
    await ctx.repo.baseline({ [OBJECT]: customObjectXml('Invoice') });
    await ctx.repo.write({ [FIELD]: textFieldXml('Due__c') });

    expect((await ctx.repo.delta()).package).to.deep.equal(['CustomField:Invoice__c.Due__c']);
  });

  it('ignores a new file excluded by .gitignore', async () => {
    await ctx.repo.baseline({ [OBJECT]: customObjectXml('Invoice') });
    await writeFile(path.join(ctx.repo.root, '.gitignore'), 'tmp-output/\n**/fields/Due__c.field-meta.xml\n', 'utf8');
    await ctx.repo.write({ [FIELD]: textFieldXml('Due__c') });

    expect((await ctx.repo.delta()).package).to.deep.equal([]);
  });

  it('gives the same delta for a new file whether it is staged or not', async () => {
    await ctx.repo.baseline({ [OBJECT]: customObjectXml('Invoice') });
    await ctx.repo.write({ [FIELD]: textFieldXml('Due__c') });

    const unstaged = await ctx.repo.delta();
    ctx.repo.git('add', '-A');
    const staged = await ctx.repo.delta();

    expect(staged.package).to.deep.equal(unstaged.package);
    expect(staged.packageFiles).to.deep.equal(unstaged.packageFiles);
  });

  it('never adds untracked files to a delta between two refs', async () => {
    const from = await ctx.repo.baseline({ [OBJECT]: customObjectXml('Invoice') });
    await ctx.repo.write({ [FIELD]: textFieldXml('Due__c') });

    expect((await ctx.repo.delta({ from, to: 'HEAD' })).package).to.deep.equal([]);
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

// Most delta tests run on FolderDeltaRepo, without git: it must report the changes git reports. It only knows the
// renames made with rename(): git also pairs a deleted file with a similar new one (a deleted field and a new field
// with the same XML shape become a rename), so the scenario keeps added and deleted files unlike each other.
describe('delta test helper: folders without git', () => {
  const CLASS = 'classes/InvoiceService.cls';
  const scenario = async (repo: DeltaRepo, from?: 'first'): Promise<DeltaOutput> => {
    const first = await repo.baseline({
      [OBJECT]: customObjectXml('Invoice'),
      [FIELD]: textFieldXml('Due__c'),
      [CLASS]: 'public class InvoiceService {}\n',
      [`${CLASS}-meta.xml`]: apexMetaXml('ApexClass'),
    });
    await repo.write({
      [OBJECT]: customObjectXml('Invoice', ['<enableHistory>true</enableHistory>']),
      ...lwcBundle('invoiceCard'),
    });
    await repo.remove(FIELD);
    repo.commit('second');
    repo.rename(CLASS, 'classes/BillingService.cls');
    repo.rename(`${CLASS}-meta.xml`, 'classes/BillingService.cls-meta.xml');
    return repo.delta(from ? { from: first, to: repo.commit('third') } : { from: first });
  };

  for (const range of [undefined, 'first'] as const) {
    it(`gives the same delta as git ${range ? 'between two commits' : 'against the working tree'}`, async () => {
      const [git, folder] = await Promise.all([GitDeltaRepo.create(), FolderDeltaRepo.create()]);
      try {
        const [fromGit, fromFolder] = [await scenario(git, range), await scenario(folder, range)];

        expect(fromFolder.result.countsByStatus).to.deep.equal(fromGit.result.countsByStatus);
        expect(fromFolder.package).to.have.members(fromGit.package);
        expect(fromFolder.destructive).to.have.members(fromGit.destructive);
        expect(fromFolder.packageFiles).to.deep.equal(fromGit.packageFiles);
        expect(fromFolder.warnings).to.equal(fromGit.warnings);
      } finally {
        await Promise.all([git.cleanup(), folder.cleanup()]);
      }
    });
  }
});
