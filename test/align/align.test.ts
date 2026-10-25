import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import type { Connection } from '@salesforce/core';

import { alignFiles, setDefaultApplication, type AlignOptions } from '../../src/align/align.js';
import {
  listedKeys,
  listOrgComponents,
  STANDARD_FIELD,
  STANDARD_OBJECT,
  STANDARD_TAB,
  USER_PERMISSION,
  type OrgComponents,
} from '../../src/align/org-components.js';
import { parseListMetadataEntries } from '../../src/retrieve/metadata-read.js';
import { componentKey, referenceKeys } from '../../src/retrieve/profile-filter.js';

const meta = (rootName: string, ...lines: string[]): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<${rootName} xmlns="http://soap.sforce.com/2006/04/metadata">`,
    ...lines.map((line) => `    ${line}`),
    `</${rootName}>`,
    '',
  ].join('\n');

const field = (name: string): string =>
  `<fieldPermissions><editable>true</editable><field>${name}</field><readable>true</readable></fieldPermissions>`;
const classAccess = (name: string): string =>
  `<classAccesses><apexClass>${name}</apexClass><enabled>true</enabled></classAccesses>`;
const application = (name: string, isDefault: boolean): string =>
  `<applicationVisibilities><application>${name}</application><default>${isDefault}</default><visible>true</visible></applicationVisibilities>`;
const userPermission = (name: string): string =>
  `<userPermissions><enabled>true</enabled><name>${name}</name></userPermissions>`;

// The org of the tests: what listMetadata (and the PermissionSet describe) would return.
const orgOf = (components: Record<string, string[] | Error>): OrgComponents =>
  new Map(
    Object.entries(components).map(([type, names]) => [
      type,
      names instanceof Error ? names : new Set(names.map((name) => componentKey(type, name))),
    ])
  );

describe('org align', () => {
  let root: string;
  let forceApp: string;
  let mainDefault: string;
  let listedTypes: string[][];

  const write = async (relativePath: string, content: string): Promise<string> => {
    const filePath = path.join(mainDefault, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
    return filePath;
  };

  const align = (org: OrgComponents, options: Partial<AlignOptions> = {}): ReturnType<typeof alignFiles> =>
    alignFiles({
      sourcePaths: [forceApp],
      projectPaths: [forceApp],
      listOrgComponents: async ({ types }) => {
        listedTypes.push(types);
        return org;
      },
      ...options,
    });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sf-df-align-'));
    forceApp = path.join(root, 'force-app');
    mainDefault = path.join(forceApp, 'main', 'default');
    listedTypes = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes from a profile the entries referring to components neither the org nor the project has', async () => {
    await write('classes/InProject.cls', 'public class InProject {}\n');
    await write('classes/InProject.cls-meta.xml', meta('ApexClass', '<apiVersion>64.0</apiVersion>'));
    const profilePath = await write(
      'profiles/Admin.profile-meta.xml',
      meta(
        'Profile',
        classAccess('InOrg'),
        classAccess('InProject'),
        classAccess('Missing'),
        '<custom>false</custom>',
        field('Account.Name'),
        field('Account.Score__c'),
        field('Account.Gone__c'),
        userPermission('ApiEnabled'),
        userPermission('RetiredPermission'),
        '<userLicense>Salesforce</userLicense>'
      )
    );

    const result = await align(
      orgOf({
        ApexClass: ['InOrg'],
        CustomField: ['Account.Score__c'],
        [USER_PERMISSION]: ['ApiEnabled'],
      })
    );

    expect(result.files).to.deep.equal([
      {
        type: 'Profile',
        fullName: 'Admin',
        filePath: profilePath,
        status: 'changed',
        removed: [
          { section: 'classAccesses', type: 'ApexClass', name: 'Missing' },
          { section: 'fieldPermissions', type: 'CustomField', name: 'Account.Gone__c' },
          { section: 'userPermissions', type: USER_PERMISSION, name: 'RetiredPermission' },
        ],
      },
    ]);
    expect(await readFile(profilePath, 'utf8')).to.equal(
      meta(
        'Profile',
        classAccess('InOrg'),
        classAccess('InProject'),
        '<custom>false</custom>',
        field('Account.Name'),
        field('Account.Score__c'),
        userPermission('ApiEnabled'),
        '<userLicense>Salesforce</userLicense>'
      )
    );
    expect(listedTypes).to.have.length(1);
    expect(listedTypes[0]).to.include.members(['ApexClass', 'CustomField', USER_PERMISSION]);
  });

  it('keeps the references of a type the org could not list', async () => {
    const profilePath = await write('profiles/Admin.profile-meta.xml', meta('Profile', classAccess('Unknown')));
    const before = await readFile(profilePath, 'utf8');

    const result = await align(orgOf({ ApexClass: new Error('INVALID_TYPE') }));

    expect(result.files).to.deep.equal([]);
    expect(result.unlistedTypes).to.deep.equal([{ type: 'ApexClass', error: 'INVALID_TYPE' }]);
    expect(await readFile(profilePath, 'utf8')).to.equal(before);
  });

  it('--dry-run reports the entries without changing the file', async () => {
    const profilePath = await write('profiles/Admin.profile-meta.xml', meta('Profile', classAccess('Missing')));
    const before = await readFile(profilePath, 'utf8');

    const result = await align(orgOf({ ApexClass: [] }), { dryRun: true });

    expect(result.files[0].removed).to.deep.equal([{ section: 'classAccesses', type: 'ApexClass', name: 'Missing' }]);
    expect(await readFile(profilePath, 'utf8')).to.equal(before);
  });

  it('keeps everything around the removed entries byte for byte, CRLF and comments included', async () => {
    const xml = meta('PermissionSet', '<!-- kept -->', classAccess('Missing'), '<label>Sales</label>').replaceAll(
      '\n',
      '\r\n'
    );
    const permissionSetPath = await write('permissionsets/Sales.permissionset-meta.xml', xml);

    await align(orgOf({ ApexClass: [] }));

    expect(await readFile(permissionSetPath, 'utf8')).to.equal(
      meta('PermissionSet', '<!-- kept -->', '<label>Sales</label>').replaceAll('\n', '\r\n')
    );
  });

  it('aligns tab settings and custom permissions of a permission set, the permission sets of a group', async () => {
    const permissionSetPath = await write(
      'permissionsets/Sales.permissionset-meta.xml',
      meta(
        'PermissionSet',
        '<customPermissions><enabled>true</enabled><name>Missing</name></customPermissions>',
        '<label>Sales</label>',
        '<tabSettings><tab>standard-Account</tab><visibility>Visible</visibility></tabSettings>',
        '<tabSettings><tab>Gone__c</tab><visibility>Visible</visibility></tabSettings>'
      )
    );
    const groupPath = await write(
      'permissionsetgroups/Sales.permissionsetgroup-meta.xml',
      meta('PermissionSetGroup', '<label>Sales</label>', '<permissionSets>Sales</permissionSets>', '<permissionSets>Gone</permissionSets>')
    );

    await align(orgOf({ CustomPermission: [], CustomTab: [], PermissionSet: [] }));

    expect(await readFile(permissionSetPath, 'utf8')).to.equal(
      meta(
        'PermissionSet',
        '<label>Sales</label>',
        '<tabSettings><tab>standard-Account</tab><visibility>Visible</visibility></tabSettings>'
      )
    );
    // Sales is in the project: it is deployed with the group.
    expect(await readFile(groupPath, 'utf8')).to.equal(
      meta('PermissionSetGroup', '<label>Sales</label>', '<permissionSets>Sales</permissionSets>')
    );
  });

  it('aligns the labels of a translation and keeps the standard tabs', async () => {
    const translationPath = await write(
      'translations/fr.translation-meta.xml',
      meta(
        'Translations',
        '<customLabels><label>Bonjour</label><name>Hello</name></customLabels>',
        '<customLabels><label>Ancien</label><name>Old</name></customLabels>',
        '<customTabs><label>Comptes</label><name>standard-Account</name></customTabs>'
      )
    );

    await align(orgOf({ CustomLabel: ['Hello'], CustomTab: [] }));

    expect(await readFile(translationPath, 'utf8')).to.equal(
      meta(
        'Translations',
        '<customLabels><label>Bonjour</label><name>Hello</name></customLabels>',
        '<customTabs><label>Comptes</label><name>standard-Account</name></customTabs>'
      )
    );
  });

  it('deletes the field translation of a missing field and aligns the object translation', async () => {
    const objectTranslationPath = await write(
      'objectTranslations/Account-fr/Account-fr.objectTranslation-meta.xml',
      meta(
        'CustomObjectTranslation',
        '<recordTypes><label>Partenaire</label><name>Partner</name></recordTypes>',
        '<recordTypes><label>Ancien</label><name>Old</name></recordTypes>'
      )
    );
    const keptPath = await write(
      'objectTranslations/Account-fr/Score__c.fieldTranslation-meta.xml',
      meta('CustomFieldTranslation', '<label>Note</label>', '<name>Score__c</name>')
    );
    const deletedPath = await write(
      'objectTranslations/Account-fr/Gone__c.fieldTranslation-meta.xml',
      meta('CustomFieldTranslation', '<label>Parti</label>', '<name>Gone__c</name>')
    );

    const result = await align(orgOf({ CustomField: ['Account.Score__c'], RecordType: ['Account.Partner'] }));

    expect(result.files.map(({ filePath, status }) => ({ filePath, status }))).to.deep.equal([
      { filePath: objectTranslationPath, status: 'changed' },
      { filePath: deletedPath, status: 'deleted' },
    ]);
    expect(await readFile(objectTranslationPath, 'utf8')).to.equal(
      meta('CustomObjectTranslation', '<recordTypes><label>Partenaire</label><name>Partner</name></recordTypes>')
    );
    expect((await stat(keptPath)).isFile()).to.equal(true);
    await stat(deletedPath).then(
      () => expect.fail('the field translation should be deleted'),
      (error: NodeJS.ErrnoException) => expect(error.code).to.equal('ENOENT')
    );
  });

  it('leaves the translation of a missing object as is, with a warning', async () => {
    const objectTranslationPath = await write(
      'objectTranslations/Gone__c-fr/Gone__c-fr.objectTranslation-meta.xml',
      meta('CustomObjectTranslation', '<gender>Masculine</gender>')
    );
    const fieldPath = await write(
      'objectTranslations/Gone__c-fr/Name__c.fieldTranslation-meta.xml',
      meta('CustomFieldTranslation', '<label>Nom</label>', '<name>Name__c</name>')
    );

    const result = await align(orgOf({ CustomObject: [], CustomField: [] }));

    expect(result.files).to.deep.equal([]);
    expect(result.skipped).to.deep.equal([
      {
        type: 'CustomObjectTranslation',
        fullName: 'Gone__c-fr',
        filePath: objectTranslationPath,
        reason: 'missingObject',
      },
    ]);
    expect((await stat(fieldPath)).isFile()).to.equal(true);
  });

  it('does not call the org when there is nothing to align', async () => {
    await write('classes/Foo.cls', 'public class Foo {}\n');
    await write('classes/Foo.cls-meta.xml', meta('ApexClass', '<apiVersion>64.0</apiVersion>'));

    const result = await align(orgOf({}));

    expect(result.files).to.deep.equal([]);
    expect(listedTypes).to.deep.equal([]);
  });

  // The rules below were found by deploying a sandbox's profile, permission sets and translations to a scratch org.
  describe('verified on a scratch org', () => {
    it('removes the standard objects and fields the org lacks: they depend on its features', async () => {
      const profilePath = await write(
        'profiles/Admin.profile-meta.xml',
        meta(
          'Profile',
          field('Case.Language'),
          field('Case.Subject'),
          field('Claim.Name'),
          '<objectPermissions><allowRead>true</allowRead><object>Claim</object></objectPermissions>'
        )
      );

      const result = await align(orgOf({ [STANDARD_OBJECT]: ['Case'], [STANDARD_FIELD]: ['Case.Subject'] }));

      expect(result.files[0].removed).to.deep.equal([
        { section: 'fieldPermissions', type: STANDARD_FIELD, name: 'Case.Language' },
        { section: 'fieldPermissions', type: STANDARD_OBJECT, name: 'Claim' },
        { section: 'objectPermissions', type: STANDARD_OBJECT, name: 'Claim' },
      ]);
      expect(await readFile(profilePath, 'utf8')).to.equal(meta('Profile', field('Case.Subject')));
    });

    it('checks the standard applications and tabs too, and the service presence statuses', async () => {
      await write(
        'profiles/Admin.profile-meta.xml',
        meta(
          'Profile',
          application('standard__AgentforceStudio', false),
          application('standard__Sales', true),
          '<servicePresenceStatusAccesses><servicePresenceStatus>Busy</servicePresenceStatus></servicePresenceStatusAccesses>',
          '<tabVisibilities><tab>standard-Account</tab><visibility>DefaultOn</visibility></tabVisibilities>',
          '<tabVisibilities><tab>standard-AccountAccountRelation</tab><visibility>DefaultOn</visibility></tabVisibilities>'
        )
      );

      const result = await align(
        orgOf({
          CustomApplication: ['standard__Sales'],
          // listMetadata answers INVALID_TYPE without Omni-Channel: no status exists.
          ServicePresenceStatus: [],
          [STANDARD_TAB]: ['standard-Account'],
        })
      );

      expect(result.files[0].removed.map(({ type, name }) => `${type}:${name}`)).to.deep.equal([
        'CustomApplication:standard__AgentforceStudio',
        'ServicePresenceStatus:Busy',
        `${STANDARD_TAB}:standard-AccountAccountRelation`,
      ]);
    });

    it('checks the web links and quick actions of translations', async () => {
      const objectTranslationPath = await write(
        'objectTranslations/Account-fr/Account-fr.objectTranslation-meta.xml',
        meta(
          'CustomObjectTranslation',
          '<quickActions><label>Appel</label><name>LogACall</name></quickActions>',
          '<webLinks><label>Site web</label><name>Open_Website</name></webLinks>'
        )
      );
      const translationPath = await write(
        'translations/fr.translation-meta.xml',
        meta('Translations', '<quickActions><label>Tache</label><name>Custom_NewTask</name></quickActions>')
      );

      await align(orgOf({ QuickAction: ['Account.LogACall'], WebLink: [] }));

      expect(await readFile(objectTranslationPath, 'utf8')).to.equal(
        meta('CustomObjectTranslation', '<quickActions><label>Appel</label><name>LogACall</name></quickActions>')
      );
      expect(await readFile(translationPath, 'utf8')).to.equal(meta('Translations'));
    });

    it('makes the default application of the target org the default when the one of the profile is removed', async () => {
      const profilePath = await write(
        'profiles/Admin.profile-meta.xml',
        meta('Profile', application('Missing_App', true), application('standard__Sales', false))
      );

      const result = await align(orgOf({ CustomApplication: ['standard__Sales'] }), {
        defaultApplication: async (profile) => (profile === 'Admin' ? 'standard__Sales' : undefined),
      });

      expect(result.files[0].defaultApplication).to.equal('standard__Sales');
      expect(result.skipped).to.deep.equal([]);
      expect(await readFile(profilePath, 'utf8')).to.equal(meta('Profile', application('standard__Sales', true)));
    });

    it('replaces the default application even when a record type is the default one', async () => {
      const recordType =
        '<recordTypeVisibilities><default>true</default><recordType>Account.Business</recordType><visible>true</visible></recordTypeVisibilities>';
      const profilePath = await write(
        'profiles/Admin.profile-meta.xml',
        meta('Profile', application('Missing_App', true), application('standard__Sales', false), recordType)
      );

      const result = await align(orgOf({ CustomApplication: ['standard__Sales'], RecordType: ['Account.Business'] }), {
        defaultApplication: async () => 'standard__Sales',
      });

      expect(result.files[0].defaultApplication).to.equal('standard__Sales');
      expect(await readFile(profilePath, 'utf8')).to.equal(
        meta('Profile', application('standard__Sales', true), recordType)
      );
    });

    it('warns when the default application is removed and the org has none for the profile', async () => {
      await write('profiles/New.profile-meta.xml', meta('Profile', application('Missing_App', true)));

      const result = await align(orgOf({ CustomApplication: [] }), { defaultApplication: async () => undefined });

      expect(result.skipped.map(({ fullName, reason }) => `${fullName}:${reason}`)).to.deep.equal([
        'New:noDefaultApplication',
      ]);
    });

    it('adds the default application, sorted and indented like the other entries, when the file lacks it', () => {
      const xml = meta('Profile', '<classAccesses><apexClass>Foo</apexClass></classAccesses>', '<custom>true</custom>');

      expect(setDefaultApplication(xml, 'standard__Sales')).to.equal(
        meta(
          'Profile',
          [
            '<applicationVisibilities>',
            '        <application>standard__Sales</application>',
            '        <default>true</default>',
            '        <visible>true</visible>',
            '    </applicationVisibilities>',
          ].join('\n'),
          '<classAccesses><apexClass>Foo</apexClass></classAccesses>',
          '<custom>true</custom>'
        )
      );
    });
  });

  describe('org components', () => {
    const fault = (code: string): Error =>
      new Error(
        `<soapenv:Envelope><soapenv:Body><soapenv:Fault><faultcode>sf:${code}</faultcode><faultstring>${code}: Cannot use</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`
      );
    const connectionOf = (failure: Error, fields: Array<[string, string]> = []): Connection =>
      ({
        accessToken: 'token',
        getApiVersion: () => '64.0',
        request: async () => {
          throw failure;
        },
        tooling: {
          query: async () => ({
            records: fields.map(([objectName, fieldName]) => ({
              QualifiedApiName: fieldName,
              EntityDefinition: { QualifiedApiName: objectName },
            })),
          }),
        },
      }) as unknown as Connection;

    it('INVALID_TYPE: the org lacks the feature, so it has none of the components of the type', async () => {
      const components = await listOrgComponents(connectionOf(fault('INVALID_TYPE')), {
        types: ['ServicePresenceStatus'],
        standardObjects: [],
      });

      expect(components.get('ServicePresenceStatus')).to.deep.equal(new Set());
    });

    it('another failure keeps the references of the type', async () => {
      const components = await listOrgComponents(connectionOf(fault('INVALID_QUERY_FILTER_OPERATOR')), {
        types: ['ApexClass'],
        standardObjects: [],
      });

      expect(components.get('ApexClass')).to.be.instanceOf(Error);
    });

    it('a standard object exists when FieldDefinition returns fields for it', async () => {
      const components = await listOrgComponents(connectionOf(fault('UNUSED'), [['Case', 'Subject']]), {
        types: [],
        standardObjects: ['Case', 'Claim'],
      });

      expect(components.get(STANDARD_OBJECT)).to.deep.equal(new Set([componentKey(STANDARD_OBJECT, 'Case')]));
      expect(components.get(STANDARD_FIELD)).to.deep.equal(new Set([componentKey(STANDARD_FIELD, 'Case.Subject')]));
    });
  });

  describe('names', () => {
    it('custom fields of tasks and events are Activity fields, person account fields Contact fields', () => {
      expect(referenceKeys('CustomField', 'Task.Score__c')).to.include(componentKey('CustomField', 'Activity.Score__c'));
      expect(referenceKeys('CustomField', 'Event.Score__c')).to.include(componentKey('CustomField', 'Activity.Score__c'));
      expect(referenceKeys('CustomField', 'Account.Score__pc')).to.include(componentKey('CustomField', 'Contact.Score__c'));
    });

    it('a managed component is known by its listed name, ns__Name and ns.Name', () => {
      const response =
        '<soapenv:Envelope><soapenv:Body><listMetadataResponse>' +
        '<result><fullName>Local</fullName><namespacePrefix></namespacePrefix></result>' +
        '<result><fullName>Helper</fullName><namespacePrefix>pkg</namespacePrefix></result>' +
        '</listMetadataResponse></soapenv:Body></soapenv:Envelope>';

      const keys = listedKeys('ApexClass', parseListMetadataEntries(response));

      expect([...keys].sort()).to.deep.equal(
        ['apexclass:helper', 'apexclass:local', 'apexclass:pkg.helper', 'apexclass:pkg__helper'].sort()
      );
    });
  });
});
