import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { mergeDriverPatterns } from '../../src/merge/merge-rules.js';
import { mergeMetadataXml } from '../../src/merge/xml-merge.js';

const HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const fieldPermission = (field: string, editable = false): string =>
  `    <fieldPermissions>\n        <editable>${editable}</editable>\n        <field>${field}</field>\n        <readable>true</readable>\n    </fieldPermissions>\n`;

// Profile with fieldPermissions on Account.F0__c ... Account.F<count-1>__c; `editable` lists the editable ones.
const profileXml = (count: number, editable: number[] = [], options: { custom?: string; extra?: string } = {}): string =>
  `${HEADER}<Profile ${NS}>\n    <custom>${options.custom ?? 'false'}</custom>\n${Array.from({ length: count }, (_, index) =>
    fieldPermission(`Account.F${index}__c`, editable.includes(index))
  ).join('')}${options.extra ?? ''}    <userLicense>Salesforce</userLicense>\n</Profile>\n`;

const labelsXml = (labels: Array<[string, string]>): string =>
  `${HEADER}<CustomLabels ${NS}>\n${labels
    .map(
      ([name, value]) =>
        `    <labels>\n        <fullName>${name}</fullName>\n        <language>en_US</language>\n        <protected>false</protected>\n        <shortDescription>${name}</shortDescription>\n        <value>${value}</value>\n    </labels>\n`
    )
    .join('')}</CustomLabels>\n`;

const merge = (base: string, ours: string, theirs: string): { content: string; conflicts: number } => {
  const result = mergeMetadataXml(base, ours, theirs);
  if (!result) {
    throw new Error('expected the file to be merged by key');
  }

  return result;
};

describe('mergeMetadataXml', () => {
  it('merges items added at the same place, which a line merge reports as a conflict', async () => {
    const base = profileXml(3);
    const ours = profileXml(3, [], { extra: fieldPermission('Account.F3__c') });
    const theirs = profileXml(3, [], { extra: fieldPermission('Account.F4__c') });

    const dir = await mkdtemp(path.join(tmpdir(), 'sf-df-merge-'));
    try {
      const files = { base: path.join(dir, 'base'), ours: path.join(dir, 'ours'), theirs: path.join(dir, 'theirs') };
      await Promise.all([writeFile(files.base, base), writeFile(files.ours, ours), writeFile(files.theirs, theirs)]);
      expect(() => execFileSync('git', ['merge-file', '-p', files.ours, files.base, files.theirs])).to.throw();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(merge(base, ours, theirs)).to.deep.equal({ content: profileXml(5), conflicts: 0 });
  });

  it('merges changes to different items of the same collection', () => {
    expect(merge(profileXml(3), profileXml(3, [0]), profileXml(3, [2]))).to.deep.equal({
      content: profileXml(3, [0, 2]),
      conflicts: 0,
    });
  });

  it('keeps the items added on both sides, each next to the item that precedes it', () => {
    const base = labelsXml([['A', 'a'], ['C', 'c']]);
    const ours = labelsXml([['A', 'a'], ['C', 'c'], ['D', 'd']]);
    const theirs = labelsXml([['A', 'a'], ['B', 'b'], ['C', 'c']]);

    expect(merge(base, ours, theirs)).to.deep.equal({
      content: labelsXml([['A', 'a'], ['B', 'b'], ['C', 'c'], ['D', 'd']]),
      conflicts: 0,
    });
  });

  it('puts conflict markers around the item changed differently on both sides, and only that item', () => {
    const base = labelsXml([['A', 'a'], ['B', 'b'], ['C', 'c']]);
    const ours = labelsXml([['A', 'a2'], ['B', 'b-ours'], ['C', 'c']]);
    const theirs = labelsXml([['A', 'a'], ['B', 'b-theirs'], ['C', 'c3']]);

    const { content, conflicts } = merge(base, ours, theirs);

    expect(conflicts).to.equal(1);
    expect(content).to.contain('<value>a2</value>');
    expect(content).to.contain('<value>c3</value>');
    const conflict = content.slice(content.indexOf('<<<<<<<'), content.indexOf('>>>>>>>'));
    expect(conflict).to.contain('<value>b-ours</value>');
    expect(conflict).to.contain('<value>b-theirs</value>');
    expect(conflict).not.to.contain('<fullName>A</fullName>');
    expect(conflict).not.to.contain('<fullName>C</fullName>');
    expect(content).to.match(/\n<<<<<<< ours\n {4}<labels>/);
    expect(content).to.match(/<\/labels>\n=======\n {4}<labels>/);
    expect(content).to.match(/<\/labels>\n>>>>>>> theirs\n {4}<labels>/);
  });

  it('keeps an item deleted on one side when the other side did not change it', () => {
    const base = labelsXml([['A', 'a'], ['B', 'b']]);

    expect(merge(base, labelsXml([['A', 'a']]), labelsXml([['A', 'a2'], ['B', 'b']])).content).to.equal(
      labelsXml([['A', 'a2']])
    );
    expect(merge(base, labelsXml([['A', 'a2'], ['B', 'b']]), labelsXml([['A', 'a']])).content).to.equal(
      labelsXml([['A', 'a2']])
    );
  });

  it('reports a conflict when one side deletes an item the other side changed', () => {
    const base = labelsXml([['A', 'a'], ['B', 'b']]);

    const oursDeleted = merge(base, labelsXml([['A', 'a']]), labelsXml([['A', 'a'], ['B', 'b2']]));
    expect(oursDeleted.conflicts).to.equal(1);
    expect(oursDeleted.content).to.match(/<<<<<<< ours\n=======\n {4}<labels>\n {8}<fullName>B<\/fullName>/);

    const theirsDeleted = merge(base, labelsXml([['A', 'a'], ['B', 'b2']]), labelsXml([['A', 'a']]));
    expect(theirsDeleted.conflicts).to.equal(1);
    expect(theirsDeleted.content).to.match(/<value>b2<\/value>\n {4}<\/labels>\n=======\n>>>>>>> theirs/);
  });

  it('merges unkeyed elements as a whole', () => {
    const base = profileXml(1);

    expect(merge(base, profileXml(1, [], { custom: 'true' }), profileXml(1, [0])).content).to.equal(
      profileXml(1, [0], { custom: 'true' })
    );
    expect(merge(base, profileXml(1, [], { custom: 'true' }), profileXml(1, [], { custom: 'true' })).conflicts).to.equal(0);
    expect(merge(profileXml(1, [], { custom: 'x' }), profileXml(1), profileXml(1, [], { custom: 'true' })).conflicts).to.equal(1);
  });

  it('keys items made of several elements (layout and record type)', () => {
    const layout = (recordType: string, layoutName: string): string =>
      `    <layoutAssignments>\n        <layout>${layoutName}</layout>\n        <recordType>${recordType}</recordType>\n    </layoutAssignments>\n`;
    const base = profileXml(0, [], { extra: layout('Account.A', 'Account-L1') + layout('Account.B', 'Account-L1') });
    const ours = profileXml(0, [], { extra: layout('Account.A', 'Account-L1') });
    const theirs = profileXml(0, [], { extra: layout('Account.A', 'Account-L1') + layout('Account.B', 'Account-L1') + layout('Account.C', 'Account-L1') });

    expect(merge(base, ours, theirs)).to.deep.equal({
      content: profileXml(0, [], { extra: layout('Account.A', 'Account-L1') + layout('Account.C', 'Account-L1') }),
      conflicts: 0,
    });
  });

  it('merges a file added on both sides', () => {
    expect(merge('', labelsXml([['A', 'a']]), labelsXml([['B', 'b']]))).to.deep.equal({
      content: labelsXml([['A', 'a'], ['B', 'b']]),
      conflicts: 0,
    });
  });

  it('keeps the CRLF line endings of the file', () => {
    const crlf = (xml: string): string => xml.replace(/\n/g, '\r\n');
    const base = crlf(labelsXml([['A', 'a']]));

    const { content } = merge(base, crlf(labelsXml([['A', 'a1']])), crlf(labelsXml([['A', 'a2']])));

    expect(content).to.contain('\r\n<<<<<<< ours\r\n');
    expect(content.replace(/\r\n/g, '')).not.to.contain('\n');
  });

  it('gives the items taken from theirs the line endings of ours', () => {
    const crlf = (xml: string): string => xml.replace(/\n/g, '\r\n');

    expect(merge(labelsXml([['A', 'a']]), crlf(labelsXml([['A', 'a']])), labelsXml([['A', 'a'], ['B', 'b']])).content).to.equal(
      crlf(labelsXml([['A', 'a'], ['B', 'b']]))
    );
  });

  it('interleaves the items added on both sides in key order', () => {
    const base = labelsXml([['M', 'm']]);
    const ours = labelsXml([['A', 'a'], ['C', 'c'], ['M', 'm'], ['X', 'x']]);
    const theirs = labelsXml([['B', 'b'], ['D', 'd'], ['M', 'm'], ['N', 'n'], ['Z', 'z']]);

    expect(merge(base, ours, theirs).content).to.equal(
      labelsXml([['A', 'a'], ['B', 'b'], ['C', 'c'], ['D', 'd'], ['M', 'm'], ['N', 'n'], ['X', 'x'], ['Z', 'z']])
    );
  });

  it('ignores comments between items and keeps them with the item that follows', () => {
    const withComment = (value: string): string =>
      labelsXml([['A', 'a'], ['B', value]]).replace('    <labels>\n        <fullName>B', '    <!-- B -->\n    <labels>\n        <fullName>B');

    expect(merge(withComment('b'), withComment('b'), withComment('b2')).content).to.equal(withComment('b2'));
  });

  it('leaves to the line merge the files it cannot merge by key', () => {
    const apex = `${HEADER}<ApexClass ${NS}>\n    <apiVersion>61.0</apiVersion>\n</ApexClass>\n`;
    expect(mergeMetadataXml(apex, apex, apex)).to.equal(undefined);

    const duplicate = labelsXml([['A', 'a'], ['A', 'b']]);
    expect(mergeMetadataXml(duplicate, duplicate, labelsXml([['A', 'a']]))).to.equal(undefined);

    const notWellFormed = labelsXml([['A', 'a']]).replace('</CustomLabels>', '');
    expect(mergeMetadataXml(notWellFormed, notWellFormed, labelsXml([['A', 'a']]))).to.equal(undefined);

    const otherNamespace = labelsXml([['A', 'a']]).replace(NS, 'xmlns="urn:other"');
    expect(mergeMetadataXml(labelsXml([['A', 'a']]), labelsXml([['A', 'b']]).replace(NS, 'xmlns="urn:mine"'), otherNamespace)).to.equal(undefined);

    // Markers between elements would otherwise be taken for indentation and kept in the result.
    const withMarkers = labelsXml([['A', 'a'], ['B', 'b']]).replace('    <labels>\n        <fullName>B', '<<<<<<< ours\n=======\n>>>>>>> theirs\n    <labels>\n        <fullName>B');
    expect(mergeMetadataXml(labelsXml([['A', 'a'], ['B', 'b']]), withMarkers, labelsXml([['A', 'a2'], ['B', 'b']]))).to.equal(undefined);
  });

  // The budgets of the two tests below catch an algorithm gone quadratic (minutes on 50 000 items), not a slow
  // machine: a merge takes ~2 s, and up to twice that while the other test files run in parallel.
  it('merges a large profile quickly', function () {
    this.timeout(60_000);
    const base = profileXml(50_000);
    const ours = profileXml(50_000, [10]);
    const theirs = profileXml(50_000, [40_000]);

    const started = performance.now();
    const { content, conflicts } = merge(base, ours, theirs);
    const elapsed = performance.now() - started;

    expect(conflicts).to.equal(0);
    expect(content).to.equal(profileXml(50_000, [10, 40_000]));
    expect(elapsed).to.be.lessThan(15_000);
  });

  // Each insertion used to rebuild the index of the whole file: 10 000 additions took minutes.
  it('merges thousands of items added by theirs quickly', function () {
    this.timeout(60_000);
    const all = Array.from({ length: 50_000 }, (_, index) => index);
    const fieldsXml = (indexes: number[], editable: number[] = []): string =>
      `${HEADER}<Profile ${NS}>\n${indexes.map((index) => fieldPermission(`Account.F${String(index).padStart(5, '0')}__c`, editable.includes(index))).join('')}</Profile>\n`;
    const base = fieldsXml(all.filter((index) => index % 5 !== 0));

    const started = performance.now();
    const { content, conflicts } = merge(base, fieldsXml(all.filter((index) => index % 5 !== 0), [1]), fieldsXml(all));
    const elapsed = performance.now() - started;

    expect(conflicts).to.equal(0);
    expect(content).to.equal(fieldsXml(all, [1]));
    expect(elapsed).to.be.lessThan(15_000);
  });
});

describe('mergeDriverPatterns', () => {
  it('lists the source file suffix of every container type', () => {
    expect(mergeDriverPatterns()).to.deep.equal([
      '*.assignmentRules-meta.xml',
      '*.autoResponseRules-meta.xml',
      '*.escalationRules-meta.xml',
      '*.labels-meta.xml',
      '*.matchingRule-meta.xml',
      '*.objectTranslation-meta.xml',
      '*.permissionset-meta.xml',
      '*.profile-meta.xml',
      '*.sharingRules-meta.xml',
      '*.translation-meta.xml',
      '*.workflow-meta.xml',
    ]);
  });
});
