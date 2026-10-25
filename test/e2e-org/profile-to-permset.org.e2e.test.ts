import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type Connection, Org } from '@salesforce/core';
import { describe, it, expect, afterAll } from 'vitest';

import { profileToPermissionSet } from '../../src/profile/to-permset.js';
import { listStandardTabs } from '../../src/retrieve/profile-deployable.js';
import { retrieveProfiles } from '../../src/retrieve/profile-retrieve.js';
import { parseSfJson, runSf } from './org-state.js';

// `sf df profile to-permset` against a real org: the accesses granted by a profile alone must be exactly those
// granted by the converted profile and its permission set together.
//
//   RUN_E2E_ORG=true E2E_TARGET_ORG=<org alias> npm run test:e2e:org
//
// Deploys a custom profile, an object, a field, a tab and a class, all named SfDfQa*, and deletes them at the end
// with the permission set. No user is created: the accesses are read from the PermissionSet records of the profile
// and of the permission set.

const targetOrg = process.env.E2E_TARGET_ORG;
const enabled = process.env.RUN_E2E_ORG === 'true' && Boolean(targetOrg);
const API = '64.0';

const meta = (type: string, body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<${type} xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}\n</${type}>\n`;

const OBJECT_FLAGS = ['Create', 'Delete', 'Edit', 'Read', 'ModifyAllRecords', 'ViewAllFields', 'ViewAllRecords'];
// A profile and a permission set name the same tab visibility differently.
const TAB_VISIBILITY: Record<string, string> = { DefaultOn: 'visible', Visible: 'visible', DefaultOff: 'available', Available: 'available' };

type SfRecord = Record<string, unknown>;

const query = async (connection: Connection, soql: string): Promise<SfRecord[]> =>
  (await connection.query<SfRecord>(soql, { autoFetch: true, maxFetch: 100_000 })).records;

// What users holding all these permission sets are granted, one line per access.
const grantedAccesses = async (connection: Connection, parentIds: string[]): Promise<string[]> => {
  const parents = parentIds.map((id) => `'${id}'`).join(', ');
  const granted = new Set<string>();
  for (const row of await query(
    connection,
    `SELECT SobjectType, ${OBJECT_FLAGS.map((flag) => `Permissions${flag}`).join(', ')} FROM ObjectPermissions WHERE ParentId IN (${parents})`
  )) {
    OBJECT_FLAGS.filter((flag) => row[`Permissions${flag}`] === true).forEach((flag) =>
      granted.add(`object ${String(row.SobjectType)} ${flag}`)
    );
  }

  for (const row of await query(
    connection,
    `SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId IN (${parents})`
  )) {
    ['Read', 'Edit'].filter((flag) => row[`Permissions${flag}`] === true).forEach((flag) =>
      granted.add(`field ${String(row.Field)} ${flag}`)
    );
  }

  for (const row of await query(
    connection,
    `SELECT SetupEntityType, SetupEntityId FROM SetupEntityAccess WHERE ParentId IN (${parents})`
  )) {
    granted.add(`setup ${String(row.SetupEntityType)} ${String(row.SetupEntityId)}`);
  }

  const tabs = new Map<string, string>();
  for (const row of await query(connection, `SELECT Name, Visibility FROM PermissionSetTabSetting WHERE ParentId IN (${parents})`)) {
    const visibility = TAB_VISIBILITY[String(row.Visibility)] ?? String(row.Visibility);
    tabs.set(String(row.Name), tabs.get(String(row.Name)) === 'visible' ? 'visible' : visibility);
  }

  tabs.forEach((visibility, name) => granted.add(`tab ${name} ${visibility}`));

  const userPermissions = (await connection.describe('PermissionSet')).fields
    .map((field) => field.name)
    .filter((name) => name.startsWith('Permissions'));
  for (const row of await query(connection, `SELECT ${userPermissions.join(', ')} FROM PermissionSet WHERE Id IN (${parents})`)) {
    userPermissions.filter((name) => row[name] === true).forEach((name) => granted.add(`user ${name.slice('Permissions'.length)}`));
  }

  return [...granted].sort();
};

const idOf = async (connection: Connection, soql: string): Promise<string> => {
  const [record] = await query(connection, soql);
  expect(record, soql).toBeDefined();
  return String(record.Id);
};

const deploy = (work: string, sourceDirs: string[]): void => {
  const result = parseSfJson<{ status: number; result?: { details?: { componentFailures?: unknown } } }>(
    runSf(['project', 'deploy', 'start', ...sourceDirs.flatMap((dir) => ['-d', dir]), '-o', targetOrg!, '-w', '30', '--json'], work)
  );
  expect(result.status, JSON.stringify(result.result?.details?.componentFailures ?? result)).toBe(0);
};

describe.skipIf(!enabled)('sf df profile to-permset on a real org', () => {
  const suffix = Date.now().toString(36).slice(-5);
  const objectName = `SfDfQa_Perm_${suffix}__c`;
  const className = `SfDfQaPerm${suffix}`;
  const profileName = `SfDfQa Perm ${suffix}`;
  const permissionSetName = `SfDfQa_Perm_${suffix}`;
  const work = mkdtempSync(path.join(tmpdir(), 'sf-df-e2e-permset-'));
  const source = path.join(work, 'force-app', 'main', 'default');
  const profilePath = path.join(source, 'profiles', `${profileName}.profile-meta.xml`);
  const permissionSetPath = path.join(source, 'permissionsets', `${permissionSetName}.permissionset-meta.xml`);
  let deployed = false;

  afterAll(() => {
    if (deployed) {
      const cleanup = path.join(work, 'cleanup');
      mkdirSync(cleanup, { recursive: true });
      writeFileSync(path.join(cleanup, 'package.xml'), meta('Package', `    <version>${API}</version>`));
      writeFileSync(
        path.join(cleanup, 'destructiveChanges.xml'),
        meta(
          'Package',
          [
            ['PermissionSet', permissionSetName],
            ['Profile', profileName],
            ['CustomTab', objectName],
            ['ApexClass', className],
            ['CustomObject', objectName],
          ]
            .map(([type, name]) => `    <types><members>${name}</members><name>${type}</name></types>`)
            .join('\n')
        )
      );
      runSf(['project', 'deploy', 'start', '--metadata-dir', cleanup, '-o', targetOrg!, '-w', '30', '--json'], work);
    }

    rmSync(work, { recursive: true, force: true });
  });

  it('the converted profile and its permission set grant what the profile granted', async () => {
    writeFileSync(
      path.join(work, 'sfdx-project.json'),
      JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: API })
    );
    const write = (relativePath: string, content: string): void => {
      mkdirSync(path.dirname(path.join(source, relativePath)), { recursive: true });
      writeFileSync(path.join(source, relativePath), content);
    };

    write(
      `objects/${objectName}/${objectName}.object-meta.xml`,
      meta(
        'CustomObject',
        [
          '    <deploymentStatus>Deployed</deploymentStatus>',
          `    <label>SfDfQa Perm ${suffix}</label>`,
          '    <nameField><label>Name</label><type>Text</type></nameField>',
          `    <pluralLabel>SfDfQa Perms ${suffix}</pluralLabel>`,
          '    <sharingModel>ReadWrite</sharingModel>',
        ].join('\n')
      )
    );
    write(
      `objects/${objectName}/fields/Score__c.field-meta.xml`,
      meta('CustomField', '    <fullName>Score__c</fullName>\n    <label>Score</label>\n    <length>10</length>\n    <type>Text</type>')
    );
    write(`tabs/${objectName}.tab-meta.xml`, meta('CustomTab', '    <customObject>true</customObject>\n    <motif>Custom20: Airplane</motif>'));
    write(`classes/${className}.cls`, `public with sharing class ${className} {}`);
    write(`classes/${className}.cls-meta.xml`, meta('ApexClass', `    <apiVersion>${API}</apiVersion>\n    <status>Active</status>`));
    deploy(work, ['force-app']);
    deployed = true;

    write(
      `profiles/${profileName}.profile-meta.xml`,
      meta(
        'Profile',
        [
          '    <applicationVisibilities><application>standard__Sales</application><default>true</default><visible>true</visible></applicationVisibilities>',
          '    <applicationVisibilities><application>standard__Service</application><default>false</default><visible>true</visible></applicationVisibilities>',
          `    <classAccesses><apexClass>${className}</apexClass><enabled>true</enabled></classAccesses>`,
          '    <custom>true</custom>',
          `    <fieldPermissions><editable>true</editable><field>${objectName}.Score__c</field><readable>true</readable></fieldPermissions>`,
          '    <objectPermissions><allowCreate>true</allowCreate><allowDelete>false</allowDelete><allowEdit>true</allowEdit>' +
            `<allowRead>true</allowRead><modifyAllRecords>false</modifyAllRecords><object>${objectName}</object>` +
            '<viewAllFields>false</viewAllFields><viewAllRecords>false</viewAllRecords></objectPermissions>',
          `    <tabVisibilities><tab>${objectName}</tab><visibility>DefaultOn</visibility></tabVisibilities>`,
          '    <tabVisibilities><tab>standard-Account</tab><visibility>DefaultOff</visibility></tabVisibilities>',
          '    <userLicense>Salesforce</userLicense>',
          '    <userPermissions><enabled>true</enabled><name>ApiEnabled</name></userPermissions>',
        ].join('\n')
      )
    );
    deploy(work, [profilePath]);

    const connection = (await Org.create({ aliasOrUsername: targetOrg })).getConnection(API);
    const profileParent = await idOf(
      connection,
      `SELECT Id FROM PermissionSet WHERE IsOwnedByProfile = true AND Profile.Name = '${profileName}'`
    );
    const before = await grantedAccesses(connection, [profileParent]);
    expect(before).toContain(`object ${objectName} Edit`);
    expect(before).toContain(`field ${objectName}.Score__c Edit`);

    // The complete profile, as a user of the command converts it.
    const retrieved = await retrieveProfiles({
      connection,
      sources: [{ fullName: profileName, filePath: profilePath }],
      filter: { entries: 'active' },
      standardTabs: new Set(await listStandardTabs(connection)),
    });
    expect(retrieved.profiles[0].status).toBe('retrieved');

    const converted = profileToPermissionSet({
      profileXml: readFileSync(profilePath, 'utf8'),
      name: permissionSetName,
      label: permissionSetName,
    });
    expect(converted.profileXml).toBeDefined();
    mkdirSync(path.dirname(permissionSetPath), { recursive: true });
    writeFileSync(permissionSetPath, converted.permissionSetXml);
    writeFileSync(profilePath, converted.profileXml!);

    // In the documented order: the permission set first, then the profile.
    deploy(work, [permissionSetPath]);
    deploy(work, [profilePath]);

    const permissionSetParent = await idOf(connection, `SELECT Id FROM PermissionSet WHERE Name = '${permissionSetName}'`);
    expect(await grantedAccesses(connection, [profileParent, permissionSetParent])).toEqual(before);

    // The profile alone no longer grants what moved; its default application stays.
    const profileAlone = await grantedAccesses(connection, [profileParent]);
    expect(profileAlone).not.toContain(`object ${objectName} Read`);
    expect(profileAlone).not.toContain(`field ${objectName}.Score__c Read`);
    expect(profileAlone).not.toContain('user ApiEnabled');
  });
});
