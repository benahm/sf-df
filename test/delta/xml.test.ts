import { expect } from 'chai';

import { ProfileStrategy } from '../../src/delta/strategies/profile-strategy.js';
import { diffCompositeXml, type XmlCollectionRules } from '../../src/delta/xml.js';

const HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const keyedBy = (fieldName: string): XmlCollectionRules[string] => ({
  keySelector: (item) => String(item[fieldName] ?? ''),
  supportsDelete: true,
});

const rules: XmlCollectionRules = { labels: keyedBy('fullName') };

const labelsXml = (labels: Array<[string, string]>, extra = ''): string =>
  `${HEADER}<CustomLabels ${NS}>\n${labels
    .map(([name, value]) => `    <labels>\n        <fullName>${name}</fullName>\n        <value>${value}</value>\n    </labels>\n`)
    .join('')}${extra}</CustomLabels>\n`;

const profileRules = (new ProfileStrategy() as unknown as { rules: XmlCollectionRules }).rules;

const fieldPermission = (field: string, editable: boolean): string =>
  `    <fieldPermissions>\n        <editable>${editable}</editable>\n        <field>${field}</field>\n        <readable>true</readable>\n    </fieldPermissions>\n`;

const profileXml = (count: number, editableIndex = -1): string =>
  `${HEADER}<Profile ${NS}>\n    <custom>true</custom>\n${Array.from({ length: count }, (_, index) =>
    fieldPermission(`Obj${index % 300}__c.Field${index}__c`, index === editableIndex)
  ).join('')}    <userLicense>Salesforce</userLicense>\n</Profile>\n`;

describe('diffCompositeXml', () => {
  it('keeps only the changed and added items of a keyed collection', () => {
    const diff = diffCompositeXml(
      labelsXml([['A', 'a'], ['B', 'b'], ['C', 'c']]),
      labelsXml([['A', 'a'], ['B', 'b2'], ['C', 'c'], ['D', 'd']]),
      'CustomLabels',
      rules
    );

    expect(diff.packageXml).to.contain('<fullName>B</fullName>');
    expect(diff.packageXml).to.contain('<fullName>D</fullName>');
    expect(diff.packageXml).not.to.contain('<fullName>A</fullName>');
    expect(diff.packageXml).not.to.contain('<fullName>C</fullName>');
    expect(diff.destructiveXml).to.equal(undefined);
  });

  it('reports deleted keys and does not treat a modified item as deleted', () => {
    const diff = diffCompositeXml(
      labelsXml([['A', 'a'], ['B', 'b']]),
      labelsXml([['A', 'a2']]),
      'CustomLabels',
      rules
    );

    expect(diff.deletedItems).to.deep.equal([{ fieldName: 'labels', key: 'B' }]);
    expect(diff.packageXml).to.contain('<value>a2</value>');
  });

  it('ignores a pure reformatting of the file', () => {
    const compact = labelsXml([['A', 'a'], ['B', 'b']]).replace(/>\s+</g, '><');

    const diff = diffCompositeXml(labelsXml([['A', 'a'], ['B', 'b']]), compact, 'CustomLabels', rules);

    expect(diff.hasChanges).to.equal(false);
    expect(diff.hasDeletes).to.equal(false);
  });

  it('keeps a whole unkeyed collection as soon as one of its elements changes', () => {
    const extra = (second: string): string => `    <loginFlows>one</loginFlows>\n    <loginFlows>${second}</loginFlows>\n`;

    const diff = diffCompositeXml(
      labelsXml([['A', 'a']], extra('two')),
      labelsXml([['A', 'a']], extra('three')),
      'CustomLabels',
      rules
    );

    expect(diff.packageXml).to.contain('<loginFlows>one</loginFlows>');
    expect(diff.packageXml).to.contain('<loginFlows>three</loginFlows>');
    expect(diff.packageXml).not.to.contain('<fullName>A</fullName>');
  });

  it('handles comments, CDATA and self-closing elements', () => {
    const withExtras = (value: string): string =>
      `${HEADER}<CustomLabels ${NS}>\n    <!-- <labels><fullName>Ghost</fullName></labels> -->\n    <labels>\n        <fullName>A</fullName>\n        <value><![CDATA[<b>${value}</b>]]></value>\n    </labels>\n    <empty/>\n</CustomLabels>\n`;

    const diff = diffCompositeXml(withExtras('x'), withExtras('y'), 'CustomLabels', rules);

    expect(diff.packageXml).to.contain('<fullName>A</fullName>');
    expect(diff.packageXml).not.to.contain('Ghost');
    expect(diff.deletedItems).to.deep.equal([]);
  });

  it('always keeps the required singleton fields of a profile', () => {
    const diff = diffCompositeXml(profileXml(5), profileXml(5, 3), 'Profile', profileRules, [
      'custom',
      'description',
      'userLicense',
    ]);

    expect(diff.packageXml).to.contain('<custom>true</custom>');
    expect(diff.packageXml).to.contain('<userLicense>Salesforce</userLicense>');
    expect(diff.packageXml).to.contain('<field>Obj3__c.Field3__c</field>');
    expect(diff.packageXml?.match(/<fieldPermissions>/g)).to.have.length(1);
  });

  it('diffs a large profile quickly', function () {
    this.timeout(20_000);
    // ~7.7 MB: a full parse of both sides took ~7 s; only the differing elements are parsed now (~0.6 s).
    const oldXml = profileXml(50_000);
    const newXml = profileXml(50_000, 42);

    const started = performance.now();
    const diff = diffCompositeXml(oldXml, newXml, 'Profile', profileRules, ['custom', 'description', 'userLicense']);
    const elapsed = performance.now() - started;

    expect(diff.packageXml?.match(/<fieldPermissions>/g)).to.have.length(1);
    expect(elapsed).to.be.lessThan(4000);
  });
});
