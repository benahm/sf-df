import { expect } from 'chai';

import { formatMetadataFile } from '../../src/retrieve/metadata-read.js';
import { permissionSetNameOf, profileToPermissionSet } from '../../src/profile/to-permset.js';

const profile = (...entries: string[]): string => formatMetadataFile('Profile', entries.join(''));
const classAccess = (name: string, enabled: boolean): string =>
  `<classAccesses><apexClass>${name}</apexClass><enabled>${enabled}</enabled></classAccesses>`;
const field = (name: string, readable: boolean, editable: boolean): string =>
  `<fieldPermissions><editable>${editable}</editable><field>${name}</field><readable>${readable}</readable></fieldPermissions>`;
const application = (name: string, isDefault: boolean, visible: boolean): string =>
  `<applicationVisibilities><application>${name}</application><default>${isDefault}</default><visible>${visible}</visible></applicationVisibilities>`;
const recordType = (name: string, isDefault: boolean, visible: boolean): string =>
  `<recordTypeVisibilities><default>${isDefault}</default><recordType>${name}</recordType><visible>${visible}</visible></recordTypeVisibilities>`;
const tab = (name: string, visibility: string): string =>
  `<tabVisibilities><tab>${name}</tab><visibility>${visibility}</visibility></tabVisibilities>`;
const userPermission = (name: string, enabled: boolean): string =>
  `<userPermissions><enabled>${enabled}</enabled><name>${name}</name></userPermissions>`;
const objectPermission = (name: string, read: boolean, edit: boolean): string =>
  '<objectPermissions><allowCreate>false</allowCreate><allowDelete>false</allowDelete>' +
  `<allowEdit>${edit}</allowEdit><allowRead>${read}</allowRead><modifyAllRecords>false</modifyAllRecords>` +
  `<object>${name}</object><viewAllFields>false</viewAllFields><viewAllRecords>false</viewAllRecords></objectPermissions>`;

const convert = (xml: string, keepProfile = false): ReturnType<typeof profileToPermissionSet> =>
  profileToPermissionSet({ profileXml: xml, name: 'Sales', label: 'Sales & Co', keepProfile });

describe('profile to permission set', () => {
  const sales = profile(
    application('Console', false, true),
    application('Sales', true, true),
    application('Service', false, false),
    classAccess('Foo', true),
    classAccess('Bar', false),
    '<custom>true</custom>',
    field('Account.Score__c', true, true),
    field('Account.Rating', false, false),
    '<layoutAssignments><layout>Account-Account Layout</layout></layoutAssignments>',
    '<loginIpRanges><endAddress>10.0.0.255</endAddress><startAddress>10.0.0.0</startAddress></loginIpRanges>',
    objectPermission('Invoice__c', true, true),
    recordType('Account.Business', true, true),
    recordType('Account.Partner', false, true),
    tab('Invoice__c', 'DefaultOn'),
    tab('standard-Account', 'DefaultOff'),
    tab('standard-Contact', 'Hidden'),
    '<userLicense>Salesforce</userLicense>',
    userPermission('ApiEnabled', true),
    userPermission('ViewSetup', false)
  );

  it('writes a permission set with the accesses the profile grants, in the order of a retrieve', () => {
    const { permissionSetXml, moved } = convert(sales);

    expect(permissionSetXml).to.equal(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">',
        '    <applicationVisibilities>',
        '        <application>Console</application>',
        '        <visible>true</visible>',
        '    </applicationVisibilities>',
        '    <applicationVisibilities>',
        '        <application>Sales</application>',
        '        <visible>true</visible>',
        '    </applicationVisibilities>',
        '    <classAccesses>',
        '        <apexClass>Foo</apexClass>',
        '        <enabled>true</enabled>',
        '    </classAccesses>',
        '    <fieldPermissions>',
        '        <editable>true</editable>',
        '        <field>Account.Score__c</field>',
        '        <readable>true</readable>',
        '    </fieldPermissions>',
        '    <hasActivationRequired>false</hasActivationRequired>',
        '    <label>Sales &amp; Co</label>',
        '    <objectPermissions>',
        '        <allowCreate>false</allowCreate>',
        '        <allowDelete>false</allowDelete>',
        '        <allowEdit>true</allowEdit>',
        '        <allowRead>true</allowRead>',
        '        <modifyAllRecords>false</modifyAllRecords>',
        '        <object>Invoice__c</object>',
        '        <viewAllFields>false</viewAllFields>',
        '        <viewAllRecords>false</viewAllRecords>',
        '    </objectPermissions>',
        '    <recordTypeVisibilities>',
        '        <recordType>Account.Business</recordType>',
        '        <visible>true</visible>',
        '    </recordTypeVisibilities>',
        '    <recordTypeVisibilities>',
        '        <recordType>Account.Partner</recordType>',
        '        <visible>true</visible>',
        '    </recordTypeVisibilities>',
        '    <tabSettings>',
        '        <tab>Invoice__c</tab>',
        '        <visibility>Visible</visibility>',
        '    </tabSettings>',
        '    <tabSettings>',
        '        <tab>standard-Account</tab>',
        '        <visibility>Available</visibility>',
        '    </tabSettings>',
        '    <userPermissions>',
        '        <enabled>true</enabled>',
        '        <name>ApiEnabled</name>',
        '    </userPermissions>',
        '</PermissionSet>',
        '',
      ].join('\n')
    );
    expect(moved).to.deep.equal({
      applicationVisibilities: 2,
      classAccesses: 1,
      fieldPermissions: 1,
      objectPermissions: 1,
      recordTypeVisibilities: 2,
      tabVisibilities: 2,
      userPermissions: 1,
    });
  });

  // A deployment never revokes an access the profile doesn't mention (verified in a sandbox, see
  // profile-strategy.ts): the moved entries stay on the profile, set to false.
  it('revokes the moved accesses on the profile, and keeps the default application and record type', () => {
    const { profileXml, standardProfile } = convert(sales);

    expect(standardProfile).to.equal(false);
    expect(profileXml).to.equal(
      profile(
        application('Console', false, false),
        application('Sales', true, true),
        application('Service', false, false),
        classAccess('Foo', false),
        classAccess('Bar', false),
        '<custom>true</custom>',
        field('Account.Score__c', false, false),
        field('Account.Rating', false, false),
        '<layoutAssignments><layout>Account-Account Layout</layout></layoutAssignments>',
        '<loginIpRanges><endAddress>10.0.0.255</endAddress><startAddress>10.0.0.0</startAddress></loginIpRanges>',
        objectPermission('Invoice__c', false, false),
        recordType('Account.Business', true, true),
        recordType('Account.Partner', false, false),
        tab('Invoice__c', 'Hidden'),
        tab('standard-Account', 'Hidden'),
        tab('standard-Contact', 'Hidden'),
        '<userLicense>Salesforce</userLicense>',
        userPermission('ApiEnabled', false),
        userPermission('ViewSetup', false)
      )
    );
  });

  it('keeps the layout of the file: only the changed values differ', () => {
    const native =
      '<?xml version="1.0" encoding="UTF-8"?>\r\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\r\n' +
      '    <!-- comment -->\r\n    <classAccesses>\r\n        <apexClass>Foo</apexClass>\r\n' +
      '        <enabled>true</enabled>\r\n    </classAccesses>\r\n    <custom>true</custom>\r\n</Profile>\r\n';

    expect(convert(native).profileXml).to.equal(native.replace('<enabled>true', '<enabled>false'));
  });

  it('--keep-profile: the profile is left as it is', () => {
    const { profileXml, permissionSetXml } = convert(sales, true);

    expect(profileXml).to.equal(undefined);
    expect(permissionSetXml).to.contain('<apexClass>Foo</apexClass>');
  });

  it('a standard profile keeps its object and user permissions', () => {
    const { profileXml, standardProfile, moved } = convert(
      profile(
        classAccess('Foo', true),
        '<custom>false</custom>',
        objectPermission('Account', true, false),
        userPermission('ApiEnabled', true)
      )
    );

    expect(standardProfile).to.equal(true);
    expect(moved).to.deep.equal({ classAccesses: 1, objectPermissions: 1, userPermissions: 1 });
    expect(profileXml).to.equal(
      profile(
        classAccess('Foo', false),
        '<custom>false</custom>',
        objectPermission('Account', true, false),
        userPermission('ApiEnabled', true)
      )
    );
  });

  it('nothing to move: an empty permission set and an unchanged profile', () => {
    const { profileXml, permissionSetXml, moved } = convert(
      profile(classAccess('Bar', false), '<custom>true</custom>')
    );

    expect(moved).to.deep.equal({});
    expect(profileXml).to.equal(undefined);
    expect(permissionSetXml).to.contain('<label>');
  });

  it('names the permission set after the profile', () => {
    expect(permissionSetNameOf('Sales Rep')).to.equal('Sales_Rep');
    expect(permissionSetNameOf('System Admin + Bulk Delete Permission')).to.equal(
      'System_Admin_Bulk_Delete_Permission'
    );
    expect(permissionSetNameOf('Équipe   commerciale (FR)')).to.equal('Equipe_commerciale_FR');
    expect(permissionSetNameOf('1 - Support')).to.equal('P_1_Support');
    expect(permissionSetNameOf(`${'A'.repeat(79)} B`)).to.equal('A'.repeat(79));
  });
});
