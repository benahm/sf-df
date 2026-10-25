import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';

import ProfileRetrieve from '../../../../src/commands/df/profile/retrieve.js';
import { readMetadataResponse } from '../../../retrieve/fake-org.js';

const STUB = '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"/>\n';
const ORG_PROFILES = ['Admin', 'Sales Manager', 'Sales Rep'];

const listMetadataResponse = (fullNames: string[]): string =>
  '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
  'xmlns="http://soap.sforce.com/2006/04/metadata"><soapenv:Body><listMetadataResponse>' +
  fullNames.map((fullName) => `<result><fullName>${fullName}</fullName><type>Profile</type></result>`).join('') +
  '</listMetadataResponse></soapenv:Body></soapenv:Envelope>';

describe('df profile retrieve', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  const initialCwd = process.cwd();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  let root: string;
  let profilesDir: string;
  let requestedUrls: string[];
  let readNames: string[];
  let listCalls: number;
  // Body of each profile in the org, after its fullName.
  let orgProfiles: Record<string, string>;
  let standardTabs: string[] | Error;

  const writeProfile = async (name: string): Promise<string> => {
    const filePath = path.join(profilesDir, `${name}.profile-meta.xml`);
    await writeFile(filePath, STUB, 'utf8');
    return filePath;
  };

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    // Earlier command tests may have failed on purpose and left an exit code.
    process.exitCode = undefined;
    await $$.stubAuths(testOrg);
    root = await mkdtemp(path.join(tmpdir(), 'sf-df-profile-command-'));
    await writeFile(
      path.join(root, 'sfdx-project.json'),
      '{\n  "packageDirectories": [{ "path": "force-app", "default": true }]\n}\n'
    );
    profilesDir = path.join(root, 'force-app', 'main', 'default', 'profiles');
    await mkdir(profilesDir, { recursive: true });
    process.chdir(root);
    // TestContext stubs the project path and the sfdx-project.json content: both point to the temporary project.
    $$.localPathRetriever = async () => root;
    $$.localPathRetrieverSync = () => root;
    $$.setConfigStubContents('SfProjectJson', {
      contents: { packageDirectories: [{ path: 'force-app', default: true }] },
    });
    requestedUrls = [];
    readNames = [];
    listCalls = 0;
    orgProfiles = Object.fromEntries(ORG_PROFILES.map((name) => [name, '<custom>false</custom>']));
    standardTabs = ['standard-Account'];
    $$.fakeConnectionRequest = async (request) => {
      const { url, body } = request as { url: string; body: string };
      requestedUrls.push(url);
      if (url.includes('/tooling/query')) {
        if (standardTabs instanceof Error) {
          throw standardTabs;
        }

        return { done: true, totalSize: standardTabs.length, records: standardTabs.map((Name) => ({ Name })) };
      }

      if (body.includes('listMetadata')) {
        listCalls += 1;
        return listMetadataResponse(ORG_PROFILES);
      }

      const name = /<m:fullNames>([^<]*)<\/m:fullNames>/.exec(body)![1];
      readNames.push(name);
      return name in orgProfiles
        ? readMetadataResponse(`<fullName>${name}</fullName>${orgProfiles[name]}`)
        : readMetadataResponse(undefined);
    };
  });

  afterEach(async () => {
    process.chdir(initialCwd);
    $$.restore();
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('retrieves the profiles and returns their status', async () => {
    const adminPath = await writeProfile('Admin');

    const result = await ProfileRetrieve.run([
      '--source-dir',
      profilesDir,
      '--target-org',
      testOrg.username,
      '--api-version',
      '62.0',
    ]);

    expect(result.profiles).to.deep.equal([{ fullName: 'Admin', filePath: adminPath, status: 'retrieved' }]);
    expect(sfCommandStubs.warn.called).to.equal(false);
    expect(await readFile(adminPath, 'utf8')).to.contain('    <custom>false</custom>\n');
    expect(requestedUrls.filter((url) => url.includes('/services/Soap/m/'))).to.have.length(1);
    expect(requestedUrls.find((url) => url.includes('/services/Soap/m/'))).to.match(/\/services\/Soap\/m\/62\.0$/);
    expect(process.exitCode).to.equal(undefined);
  });

  it('accepts -a and several -d, as sf project retrieve start', async () => {
    await writeProfile('Admin');
    const otherDir = path.join(root, 'other', 'profiles');
    await mkdir(otherDir, { recursive: true });
    await writeFile(path.join(otherDir, 'Sales Rep.profile-meta.xml'), STUB, 'utf8');

    const result = await ProfileRetrieve.run(['-d', profilesDir, '-d', otherDir, '-o', testOrg.username, '-a', '62.0']);

    expect(result.profiles.map(({ fullName }) => fullName)).to.deep.equal(['Admin', 'Sales Rep']);
    expect(requestedUrls.find((url) => url.includes('/services/Soap/m/'))).to.match(/\/services\/Soap\/m\/62\.0$/);
  });

  it('retrieves every profile of the project without --source-dir', async () => {
    await writeProfile('Admin');
    await writeProfile('Sales Rep');

    const result = await ProfileRetrieve.run(['--target-org', testOrg.username]);

    expect(result.profiles.map(({ fullName, status }) => [fullName, status])).to.deep.equal([
      ['Admin', 'retrieved'],
      ['Sales Rep', 'retrieved'],
    ]);
    expect(listCalls).to.equal(0);
  });

  it('--metadata overwrites a profile of the project and writes a new one to the default package directory', async () => {
    const adminPath = await writeProfile('Admin');
    await writeProfile('Sales Manager');

    const result = await ProfileRetrieve.run([
      '--metadata',
      'Profile:Admin',
      '--metadata',
      'Profile:Sales Rep',
      '--target-org',
      testOrg.username,
    ]);

    const salesRepPath = path.join(root, 'force-app', 'main', 'default', 'profiles', 'Sales Rep.profile-meta.xml');
    expect(result.profiles).to.deep.equal([
      { fullName: 'Admin', filePath: adminPath, status: 'retrieved' },
      { fullName: 'Sales Rep', filePath: salesRepPath, status: 'retrieved' },
    ]);
    expect(await readFile(salesRepPath, 'utf8')).to.contain('<custom>false</custom>');
    expect(await readFile(path.join(profilesDir, 'Sales Manager.profile-meta.xml'), 'utf8')).to.equal(STUB);
    expect(listCalls).to.equal(0);
  });

  it('--metadata resolves wildcards against the org', async () => {
    const result = await ProfileRetrieve.run(['-m', 'Profile:Sales*', '-o', testOrg.username]);

    expect(result.profiles.map(({ fullName }) => fullName)).to.deep.equal(['Sales Manager', 'Sales Rep']);
    expect(listCalls).to.equal(1);
  });

  it('--metadata Profile retrieves every profile of the org', async () => {
    const result = await ProfileRetrieve.run(['-m', 'Profile', '-o', testOrg.username]);

    expect(result.profiles.map(({ fullName }) => fullName)).to.deep.equal(ORG_PROFILES);
  });

  it('--metadata refuses another type', async () => {
    try {
      await ProfileRetrieve.run(['-m', 'ApexClass:Foo', '-o', testOrg.username]);
      expect.fail('expected an error');
    } catch (error) {
      expect((error as Error).message).to.contain("isn't a profile");
    }
  });

  it('--manifest retrieves the Profile members and ignores the other types', async () => {
    const manifest = path.join(root, 'package.xml');
    await writeFile(
      manifest,
      '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '    <types>\n        <members>Foo</members>\n        <name>ApexClass</name>\n    </types>\n' +
        '    <types>\n        <members>Admin</members>\n        <name>Profile</name>\n    </types>\n' +
        '    <version>62.0</version>\n</Package>\n',
      'utf8'
    );

    const result = await ProfileRetrieve.run(['-x', manifest, '-o', testOrg.username]);

    expect(result.profiles.map(({ fullName }) => fullName)).to.deep.equal(['Admin']);
    expect(readNames).to.deep.equal(['Admin']);
  });

  it('--source-dir, --metadata and --manifest are mutually exclusive', async () => {
    try {
      await ProfileRetrieve.run(['-d', profilesDir, '-m', 'Profile:Admin', '-o', testOrg.username]);
      expect.fail('expected an error');
    } catch (error) {
      expect((error as Error).message).to.match(/cannot also be provided/);
    }
  });

  it('writes to <output-dir>/profiles, as sf project retrieve start does', async () => {
    const adminPath = await writeProfile('Admin');
    const outputDir = path.join(root, 'retrieved');

    const result = await ProfileRetrieve.run(['-m', 'Profile:Admin', '-r', outputDir, '-o', testOrg.username]);

    expect(result.profiles[0].filePath).to.equal(path.join(outputDir, 'profiles', 'Admin.profile-meta.xml'));
    expect(await readFile(adminPath, 'utf8')).to.equal(STUB);
  });

  it('warns and exits with 1 when a profile is missing from the org', async () => {
    await writeProfile('Ghost');

    const result = await ProfileRetrieve.run(['--source-dir', profilesDir, '--target-org', testOrg.username]);

    expect(result.profiles[0].status).to.equal('notFound');
    expect(sfCommandStubs.warn.firstCall.args[0]).to.contain('Ghost');
    expect(process.exitCode).to.equal(1);
  });

  it('fails when the source contains no profile', async () => {
    try {
      await ProfileRetrieve.run(['--source-dir', profilesDir, '--target-org', testOrg.username]);
      expect.fail('expected an error');
    } catch (error) {
      expect((error as Error).message).to.contain('No profile found');
    }
  });

  it('fails when no profile of the org matches the wildcard', async () => {
    try {
      await ProfileRetrieve.run(['-m', 'Profile:Nobody*', '--target-org', testOrg.username]);
      expect.fail('expected an error');
    } catch (error) {
      expect((error as Error).message).to.contain('No profile found in Profile:Nobody*');
    }
  });
  describe('a profile that deploys', () => {
    const tab = (name: string): string =>
      `<tabVisibilities><tab>${name}</tab><visibility>DefaultOn</visibility></tabVisibilities>`;
    const assignment = (layout: string, recordType: string): string =>
      `<layoutAssignments><layout>${layout}</layout><recordType>${recordType}</recordType></layoutAssignments>`;

    it('leaves out the standard tabs the org refuses and the layouts assigned twice, with a warning', async () => {
      const adminPath = await writeProfile('Admin');
      orgProfiles.Admin = [
        '<custom>false</custom>',
        assignment('Case-Claims Layout', 'Case.Claims'),
        assignment('CaseClose-Closing Layout', 'Case.Claims'),
        assignment('PersonAccount-Client Layout', 'PersonAccount.Client'),
        assignment('PersonAccount-Retail Layout', 'PersonAccount.Client'),
        tab('standard-Account'),
        tab('standard-AccountAccountRelation'),
        tab('Invoice__c'),
      ].join('');

      const result = await ProfileRetrieve.run(['-d', profilesDir, '-o', testOrg.username]);

      expect(result.profiles[0].leftOut).to.deep.equal([
        { section: 'layoutAssignments', name: 'PersonAccount.Client' },
        { section: 'tabVisibilities', name: 'standard-AccountAccountRelation' },
      ]);
      const written = await readFile(adminPath, 'utf8');
      expect(written).to.contain('Case-Claims Layout').and.contain('CaseClose-Closing Layout');
      expect(written).to.contain('standard-Account<').and.contain('Invoice__c');
      expect(written).not.to.contain('PersonAccount').and.not.to.contain('AccountAccountRelation');
      const warnings = sfCommandStubs.warn.getCalls().map((call) => call.args[0] as string);
      expect(warnings).to.have.length(2);
      expect(warnings[0]).to.contain('1 settings of standard tabs');
      expect(warnings[1]).to.contain('PersonAccount.Client');
      expect(process.exitCode).to.equal(undefined);
    });

    it("keeps every tab setting when the org can't list its standard tabs", async () => {
      const adminPath = await writeProfile('Admin');
      orgProfiles.Admin = `<custom>false</custom>${tab('standard-AccountAccountRelation')}`;
      standardTabs = new Error('INSUFFICIENT_ACCESS');

      await ProfileRetrieve.run(['-d', profilesDir, '-o', testOrg.username]);

      expect(await readFile(adminPath, 'utf8')).to.contain('standard-AccountAccountRelation');
      expect(sfCommandStubs.warn.firstCall.args[0]).to.contain('INSUFFICIENT_ACCESS');
    });
  });

  describe('--entries and --scope', () => {
    const classAccess = (name: string, enabled: boolean): string =>
      `<classAccesses><apexClass>${name}</apexClass><enabled>${enabled}</enabled></classAccesses>`;

    beforeEach(() => {
      orgProfiles.Admin = [
        classAccess('InProject', true),
        classAccess('Disabled', false),
        classAccess('OrgOnly', true),
        '<custom>false</custom>',
      ].join('');
    });

    const apexClasses = async (filePath: string): Promise<string[]> =>
      [...(await readFile(filePath, 'utf8')).matchAll(/<apexClass>([^<]*)<\/apexClass>/g)].map((match) => match[1]);

    it('active by default: the entries granting nothing are left out', async () => {
      const adminPath = await writeProfile('Admin');

      await ProfileRetrieve.run(['-d', profilesDir, '-o', testOrg.username]);

      expect(await apexClasses(adminPath)).to.deep.equal(['InProject', 'OrgOnly']);
    });

    it('--entries all keeps every entry', async () => {
      const adminPath = await writeProfile('Admin');

      await ProfileRetrieve.run(['-d', profilesDir, '-o', testOrg.username, '--entries', 'all']);

      expect(await apexClasses(adminPath)).to.deep.equal(['InProject', 'Disabled', 'OrgOnly']);
    });

    it('--scope project keeps the accesses to the components of the project', async () => {
      const adminPath = await writeProfile('Admin');
      const classesDir = path.join(root, 'force-app', 'main', 'default', 'classes');
      await mkdir(classesDir, { recursive: true });
      await writeFile(path.join(classesDir, 'InProject.cls'), 'public class InProject {}', 'utf8');
      await writeFile(
        path.join(classesDir, 'InProject.cls-meta.xml'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
          '    <apiVersion>62.0</apiVersion>\n    <status>Active</status>\n</ApexClass>\n',
        'utf8'
      );

      await ProfileRetrieve.run(['-d', profilesDir, '-o', testOrg.username, '--scope', 'project']);

      expect(await apexClasses(adminPath)).to.deep.equal(['InProject']);
    });
  });
});
