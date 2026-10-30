import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect } from 'chai';

import type { DeltaComponent } from '../../src/delta/types.js';
import { SOURCE_DIR, useDeltaRepo } from './helpers/delta-repo.js';
import { apexClass, customObjectXml, flowXml, lwcBundle, profileXml, textFieldXml, userPermission } from './helpers/metadata-xml.js';

// `components` and `skippedFiles` of the result: what `sf df git delta` prints, component by component, with the git
// files behind each one.

const inSource = (...files: string[]): string[] => files.map((file) => `${SOURCE_DIR}/${file}`);
const row = ({ manifest, action, type, fullName }: DeltaComponent): string => `${manifest} ${action} ${type}:${fullName}`;

describe('delta components', () => {
  const ctx = useDeltaRepo();

  it('gives each component its action and the git files behind it', async () => {
    await ctx.repo.baseline({ ...apexClass('Kept'), ...apexClass('Gone') });
    await ctx.repo.write({ ...apexClass('Kept', ' void run() {}'), ...apexClass('Added') });
    await ctx.repo.remove('classes/Gone.cls', 'classes/Gone.cls-meta.xml');

    const { result } = await ctx.repo.delta();

    expect(result.components).to.deep.equal([
      { type: 'ApexClass', fullName: 'Added', action: 'add', manifest: 'package', files: inSource('classes/Added.cls', 'classes/Added.cls-meta.xml') },
      { type: 'ApexClass', fullName: 'Kept', action: 'modify', manifest: 'package', files: inSource('classes/Kept.cls') },
      { type: 'ApexClass', fullName: 'Gone', action: 'delete', manifest: 'destructive', files: inSource('classes/Gone.cls', 'classes/Gone.cls-meta.xml') },
    ]);
    expect(result.skippedFiles).to.deep.equal([]);
  });

  it('shows a rename as the new component renamed and the old one deleted', async () => {
    await ctx.repo.baseline(apexClass('OldName'));
    ctx.repo.rename('classes/OldName.cls', 'classes/NewName.cls');
    ctx.repo.rename('classes/OldName.cls-meta.xml', 'classes/NewName.cls-meta.xml');
    await ctx.repo.write({ 'classes/NewName.cls': 'public with sharing class NewName {}\n' });

    const { result } = await ctx.repo.delta();

    expect(result.components.map(row)).to.deep.equal(['package rename ApexClass:NewName', 'destructive delete ApexClass:OldName']);
    expect(result.components[1].files).to.deep.equal(inSource('classes/OldName.cls', 'classes/OldName.cls-meta.xml'));
  });

  it('shows a deleted flow as its FlowDefinition deactivated', async () => {
    await ctx.repo.baseline({ 'flows/Invoice_Sent.flow-meta.xml': flowXml('Invoice sent') });
    await ctx.repo.remove('flows/Invoice_Sent.flow-meta.xml');

    const { result } = await ctx.repo.delta();

    expect(result.components.map(row)).to.deep.equal(['package deactivate FlowDefinition:Invoice_Sent']);
  });

  it('lists every changed file of a bundle under the bundle, a file deleted from it as a modification', async () => {
    await ctx.repo.baseline(lwcBundle('invoiceCard'));
    await ctx.repo.write({ 'lwc/invoiceCard/invoiceCard.js': 'export default class {}\n' });
    await ctx.repo.remove('lwc/invoiceCard/invoiceCard.html');

    const { result } = await ctx.repo.delta();

    expect(result.components).to.deep.equal([
      {
        type: 'LightningComponentBundle',
        fullName: 'invoiceCard',
        action: 'modify',
        manifest: 'package',
        files: inSource('lwc/invoiceCard/invoiceCard.html', 'lwc/invoiceCard/invoiceCard.js'),
      },
    ]);
  });

  it('lists the files of the children of a deleted object under the object', async () => {
    await ctx.repo.baseline({
      'objects/Invoice__c/Invoice__c.object-meta.xml': customObjectXml('Invoice'),
      'objects/Invoice__c/fields/Number__c.field-meta.xml': textFieldXml('Number__c'),
    });
    await ctx.repo.remove('objects/Invoice__c');

    const { result } = await ctx.repo.delta();

    expect(result.components).to.deep.equal([
      {
        type: 'CustomObject',
        fullName: 'Invoice__c',
        action: 'delete',
        manifest: 'destructive',
        files: inSource('objects/Invoice__c/Invoice__c.object-meta.xml', 'objects/Invoice__c/fields/Number__c.field-meta.xml'),
      },
    ]);
  });

  it('reports the changed files that put nothing in the delta', async () => {
    await writeFile(path.join(ctx.repo.root, '.forceignore'), '**/jsconfig.json\n', 'utf8');
    await ctx.repo.baseline({ 'profiles/Admin.profile-meta.xml': profileXml(userPermission('ApiEnabled')) });
    // Same profile, reformatted only.
    await ctx.repo.write({
      'profiles/Admin.profile-meta.xml': `${profileXml(userPermission('ApiEnabled'))}\n`,
      'lwc/jsconfig.json': '{}\n',
    });

    const { result } = await ctx.repo.delta();

    expect(result.components).to.deep.equal([]);
    expect(result.skippedFiles).to.deep.equal([
      { path: `${SOURCE_DIR}/lwc/jsconfig.json`, reason: 'forceignore' },
      { path: `${SOURCE_DIR}/profiles/Admin.profile-meta.xml`, reason: 'no-change' },
    ]);
  });
});
