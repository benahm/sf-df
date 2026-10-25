import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';

import ProfileToPermset from '../../../../src/commands/df/profile/to-permset.js';
import { formatMetadataFile } from '../../../../src/retrieve/metadata-read.js';

const classAccess = (name: string, enabled: boolean): string =>
  `<classAccesses><apexClass>${name}</apexClass><enabled>${enabled}</enabled></classAccesses>`;
const profile = (custom: boolean, ...entries: string[]): string =>
  formatMetadataFile('Profile', [...entries, `<custom>${custom}</custom>`].join(''));

describe('df profile to-permset', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  let root: string;
  let profilesDir: string;
  let permissionSetsDir: string;

  const writeProfile = async (name: string, xml: string): Promise<string> => {
    const filePath = path.join(profilesDir, `${name}.profile-meta.xml`);
    await writeFile(filePath, xml, 'utf8');
    return filePath;
  };

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    root = await mkdtemp(path.join(tmpdir(), 'sf-df-to-permset-'));
    profilesDir = path.join(root, 'force-app', 'main', 'default', 'profiles');
    permissionSetsDir = path.join(root, 'force-app', 'main', 'default', 'permissionsets');
    await mkdir(profilesDir, { recursive: true });
  });

  afterEach(async () => {
    $$.restore();
    await rm(root, { recursive: true, force: true });
  });

  it('writes the permission set next to the profiles and revokes the accesses on the profile', async () => {
    const salesPath = await writeProfile('Sales Rep', profile(true, classAccess('Foo', true)));

    const result = await ProfileToPermset.run(['--source-dir', salesPath]);

    const permissionSetPath = path.join(permissionSetsDir, 'Sales_Rep.permissionset-meta.xml');
    expect(result.profiles).to.deep.equal([
      {
        profile: 'Sales Rep',
        profilePath: salesPath,
        profileChanged: true,
        standardProfile: false,
        permissionSet: 'Sales_Rep',
        permissionSetPath,
        moved: { classAccesses: 1 },
      },
    ]);
    const permissionSet = await readFile(permissionSetPath, 'utf8');
    expect(permissionSet).to.contain('<apexClass>Foo</apexClass>').and.contain('<label>Sales Rep</label>');
    expect(permissionSet).to.contain('<description>Accesses of the Sales Rep profile');
    expect(await readFile(salesPath, 'utf8')).to.equal(profile(true, classAccess('Foo', false)));
    expect(sfCommandStubs.warn.lastCall.args[0]).to.contain('before deploying the profiles');
  });

  it('converts every profile of a folder, and leaves a standard profile with a warning', async () => {
    await writeProfile('Sales', profile(true, classAccess('Foo', true)));
    await writeProfile('System Admin %2B Bulk', profile(false, classAccess('Foo', true)));

    const result = await ProfileToPermset.run(['-d', profilesDir, '--keep-profile']);

    expect(result.profiles.map(({ permissionSet, profileChanged }) => [permissionSet, profileChanged])).to.deep.equal([
      ['Sales', false],
      ['System_Admin_Bulk', false],
    ]);
    expect(await readFile(path.join(permissionSetsDir, 'System_Admin_Bulk.permissionset-meta.xml'), 'utf8')).to.contain(
      '<label>System Admin + Bulk</label>'
    );
    expect(sfCommandStubs.warn.getCalls().map((call) => call.args[0] as string)).to.deep.equal([
      'Profile "System Admin %2B Bulk" is a standard profile: its object and user permissions were copied but not revoked.',
    ]);
  });

  it('--keep-profile then a second run: the permission set is kept and the profile revoked', async () => {
    const salesPath = await writeProfile('Sales', profile(true, classAccess('Foo', true)));
    await ProfileToPermset.run(['-d', salesPath, '--keep-profile']);
    const permissionSetPath = path.join(permissionSetsDir, 'Sales.permissionset-meta.xml');
    const permissionSet = await readFile(permissionSetPath, 'utf8');

    const result = await ProfileToPermset.run(['-d', salesPath]);

    expect(result.profiles[0].profileChanged).to.equal(true);
    expect(await readFile(permissionSetPath, 'utf8')).to.equal(permissionSet);
    expect(await readFile(salesPath, 'utf8')).to.contain('<enabled>false</enabled>');
  });

  it('refuses to overwrite a different permission set, before writing anything', async () => {
    const salesPath = await writeProfile('Sales', profile(true, classAccess('Foo', true)));
    await mkdir(permissionSetsDir, { recursive: true });
    await writeFile(path.join(permissionSetsDir, 'Sales.permissionset-meta.xml'), 'other', 'utf8');

    try {
      await ProfileToPermset.run(['-d', salesPath]);
      expect.fail('expected an error');
    } catch (error) {
      expect((error as Error).message).to.contain('already exists with other accesses');
    }

    expect(await readFile(salesPath, 'utf8')).to.equal(profile(true, classAccess('Foo', true)));
  });

  it('--name, --label and --output-dir', async () => {
    const salesPath = await writeProfile('Sales', profile(true, classAccess('Foo', true)));
    const outputDir = path.join(root, 'out');

    const result = await ProfileToPermset.run(['-d', salesPath, '-n', 'Sales_Access', '-l', 'Sales access', '-r', outputDir]);

    expect(result.profiles[0].permissionSetPath).to.equal(path.join(outputDir, 'Sales_Access.permissionset-meta.xml'));
    expect(await readFile(result.profiles[0].permissionSetPath, 'utf8')).to.contain('<label>Sales access</label>');
  });

  it('--name needs a single profile', async () => {
    await writeProfile('Sales', profile(true));
    await writeProfile('Support', profile(true));

    try {
      await ProfileToPermset.run(['-d', profilesDir, '-n', 'Access']);
      expect.fail('expected an error');
    } catch (error) {
      expect((error as Error).message).to.contain('need a single profile, 2 were found');
    }
  });

  it('fails when the source contains no profile', async () => {
    try {
      await ProfileToPermset.run(['-d', profilesDir]);
      expect.fail('expected an error');
    } catch (error) {
      expect((error as Error).message).to.contain('No profile found');
    }
  });
});
