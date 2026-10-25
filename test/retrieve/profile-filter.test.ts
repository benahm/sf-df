import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { formatMetadataFile } from '../../src/retrieve/metadata-read.js';
import {
  componentKey,
  filterProfile,
  profileEntryKeys,
  projectComponentKeys,
} from '../../src/retrieve/profile-filter.js';

const field = (name: string, readable: boolean, editable = false): string =>
  `<fieldPermissions><editable>${editable}</editable><field>${name}</field><readable>${readable}</readable></fieldPermissions>`;
const classAccess = (name: string, enabled: boolean): string =>
  `<classAccesses><apexClass>${name}</apexClass><enabled>${enabled}</enabled></classAccesses>`;

// A profile as readMetadata returns it, written as the command writes it.
const profile = (...entries: string[]): string => formatMetadataFile('Profile', entries.join(''));

// Values of a given child in the filtered file, in order.
const values = (xml: string, child: string): string[] =>
  [...xml.matchAll(new RegExp(`<${child}>([^<]*)</${child}>`, 'g'))].map((match) => match[1]);

describe('profile filter', () => {
  const settings = [
    '<custom>false</custom>',
    '<layoutAssignments><layout>Account-Account Layout</layout></layoutAssignments>',
    '<tabVisibilities><tab>standard-Account</tab><visibility>Hidden</visibility></tabVisibilities>',
    '<userLicense>Salesforce</userLicense>',
  ];

  it('all, scope org: the profile is written as the org returns it', () => {
    const xml = profile(classAccess('Foo', false), field('Account.Name', false), ...settings);

    expect(filterProfile(xml, { entries: 'all' })).to.equal(xml);
  });

  it('active leaves out the entries granting nothing, and keeps the settings', () => {
    const xml = profile(
      classAccess('Foo', true),
      classAccess('Bar', false),
      field('Account.Name', true),
      field('Account.Score__c', false, false),
      field('Account.Rating', false, true),
      ...settings
    );

    const filtered = filterProfile(xml, { entries: 'active' });

    expect(values(filtered, 'apexClass')).to.deep.equal(['Foo']);
    expect(values(filtered, 'field')).to.deep.equal(['Account.Name', 'Account.Rating']);
    expect(values(filtered, 'visibility')).to.deep.equal(['Hidden']);
    expect(values(filtered, 'layout')).to.deep.equal(['Account-Account Layout']);
    expect(values(filtered, 'userLicense')).to.deep.equal(['Salesforce']);
    expect(filtered.split('\n').slice(0, 2)).to.deep.equal(xml.split('\n').slice(0, 2));
    expect(filtered.endsWith('</Profile>\n')).to.equal(true);
  });

  // A deployment never revokes what the profile doesn't mention (verified in a sandbox, see profile-strategy.ts):
  // an access revoked in the org must be written as false, not dropped.
  it('active keeps an entry of the local file with the value of the org, so that a revocation deploys', () => {
    const local = profile(field('Account.Score__c', true), classAccess('Foo', true));
    const xml = profile(field('Account.Score__c', false), field('Account.Other__c', false), classAccess('Foo', false));

    const filtered = filterProfile(xml, { entries: 'active' }, local);

    expect(values(filtered, 'field')).to.deep.equal(['Account.Score__c']);
    expect(values(filtered, 'readable')).to.deep.equal(['false']);
    expect(values(filtered, 'apexClass')).to.deep.equal(['Foo']);
    expect(values(filtered, 'enabled')).to.deep.equal(['false']);
  });

  it('reads the keys of a local file whatever its layout', () => {
    const keys = profileEntryKeys(
      '<Profile><fieldPermissions>\n\t<field>Account.Score__c</field></fieldPermissions>' +
        '<layoutAssignments><layout>Case-Case Layout</layout><recordType>Case.Support</recordType></layoutAssignments></Profile>'
    );

    expect([...keys]).to.deep.equal([
      'fieldPermissions:Account.Score__c',
      'layoutAssignments:Case-Case Layout::Case.Support',
    ]);
  });

  it('scope project keeps the accesses to the project and to standard components only', () => {
    const projectComponents = new Set([
      componentKey('CustomField', 'Account.Score__c'),
      componentKey('CustomObject', 'Invoice__c'),
      componentKey('ApexClass', 'Foo'),
      componentKey('Layout', 'Account-Account %28Sales%29 Layout'),
    ]);
    const xml = profile(
      classAccess('Foo', true),
      classAccess('ns__Managed', true),
      field('Account.Name', true),
      field('Account.Score__c', true),
      field('Account.Hand_Made__c', true),
      field('Account.ns__Rank__c', true),
      field('Invoice__c.Name', true),
      field('Order__c.Name', true),
      '<objectPermissions><allowRead>true</allowRead><object>Account</object></objectPermissions>',
      '<objectPermissions><allowRead>true</allowRead><object>Order__c</object></objectPermissions>',
      '<layoutAssignments><layout>Account-Account (Sales) Layout</layout></layoutAssignments>',
      '<layoutAssignments><layout>Case-Case Layout</layout></layoutAssignments>',
      '<tabVisibilities><tab>standard-Account</tab><visibility>DefaultOn</visibility></tabVisibilities>',
      '<tabVisibilities><tab>Order__c</tab><visibility>DefaultOn</visibility></tabVisibilities>',
      '<userPermissions><enabled>true</enabled><name>ApiEnabled</name></userPermissions>'
    );

    const filtered = filterProfile(xml, { entries: 'all', projectComponents });

    expect(values(filtered, 'apexClass')).to.deep.equal(['Foo']);
    expect(values(filtered, 'field')).to.deep.equal(['Account.Name', 'Account.Score__c', 'Invoice__c.Name']);
    expect(values(filtered, 'object')).to.deep.equal(['Account']);
    expect(values(filtered, 'layout')).to.deep.equal(['Account-Account (Sales) Layout']);
    expect(values(filtered, 'tab')).to.deep.equal(['standard-Account']);
    expect(values(filtered, 'name')).to.deep.equal(['ApiEnabled']);
  });

  it('scope project drops an entry of the local file whose component left the project', () => {
    const local = profile(field('Account.Gone__c', true));
    const xml = profile(field('Account.Gone__c', false));

    const filtered = filterProfile(xml, { entries: 'active', projectComponents: new Set() }, local);

    expect(values(filtered, 'field')).to.deep.equal([]);
  });

  it('stays fast on a large profile', () => {
    const entries = Array.from({ length: 30_000 }, (_, index) => field(`Account.F${index}__c`, index % 2 === 0));
    const xml = profile(...entries);
    const local = profile(...entries.slice(0, 10_000));
    const projectComponents = new Set(entries.map((_, index) => componentKey('CustomField', `Account.F${index}__c`)));

    const started = Date.now();
    const filtered = filterProfile(xml, { entries: 'active', projectComponents }, local);

    expect(values(filtered, 'field')).to.have.length(20_000);
    expect(Date.now() - started).to.be.below(5000);
  });

  describe('project components', () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'sf-df-profile-filter-'));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('lists the fields and record types of the project, with decoded names', async () => {
      const objectDir = path.join(root, 'force-app', 'main', 'default', 'objects', 'Account');
      await mkdir(path.join(objectDir, 'fields'), { recursive: true });
      await mkdir(path.join(objectDir, 'recordTypes'), { recursive: true });
      const layoutsDir = path.join(root, 'force-app', 'main', 'default', 'layouts');
      await mkdir(layoutsDir, { recursive: true });
      const meta = (rootName: string, body: string): string =>
        `<?xml version="1.0" encoding="UTF-8"?>\n<${rootName} xmlns="http://soap.sforce.com/2006/04/metadata">${body}</${rootName}>\n`;
      await writeFile(path.join(objectDir, 'Account.object-meta.xml'), meta('CustomObject', ''));
      await writeFile(
        path.join(objectDir, 'fields', 'Score__c.field-meta.xml'),
        meta('CustomField', '<fullName>Score__c</fullName><type>Number</type>')
      );
      await writeFile(
        path.join(objectDir, 'recordTypes', 'Partner.recordType-meta.xml'),
        meta('RecordType', '<fullName>Partner</fullName><active>true</active>')
      );
      await writeFile(path.join(layoutsDir, 'Account-Account %28Sales%29 Layout.layout-meta.xml'), meta('Layout', ''));

      const keys = projectComponentKeys([path.join(root, 'force-app')]);

      expect(keys.has(componentKey('CustomField', 'Account.Score__c'))).to.equal(true);
      expect(keys.has(componentKey('RecordType', 'Account.Partner'))).to.equal(true);
      expect(keys.has(componentKey('Layout', 'Account-Account (Sales) Layout'))).to.equal(true);
    });
  });
});
