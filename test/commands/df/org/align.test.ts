import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';

import OrgAlign from '../../../../src/commands/df/org/align.js';

const PROFILE =
  '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
  '    <classAccesses><apexClass>InOrg</apexClass><enabled>true</enabled></classAccesses>\n' +
  '    <classAccesses><apexClass>Missing</apexClass><enabled>true</enabled></classAccesses>\n' +
  '    <userPermissions><enabled>true</enabled><name>ApiEnabled</name></userPermissions>\n' +
  '</Profile>\n';

// listMetadata and the PermissionSet describe, as the org answers them.
const ORG: Record<string, string[]> = { ApexClass: ['InOrg'] };
const listResponse = (names: string[]): string =>
  '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><listMetadataResponse>' +
  names.map((name) => `<result><fullName>${name}</fullName><namespacePrefix></namespacePrefix></result>`).join('') +
  '</listMetadataResponse></soapenv:Body></soapenv:Envelope>';

describe('df org align', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  const initialCwd = process.cwd();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  let root: string;
  let profilePath: string;

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    root = await mkdtemp(path.join(tmpdir(), 'sf-df-org-align-command-'));
    await writeFile(
      path.join(root, 'sfdx-project.json'),
      '{\n  "packageDirectories": [{ "path": "force-app", "default": true }]\n}\n'
    );
    const profilesDir = path.join(root, 'force-app', 'main', 'default', 'profiles');
    await mkdir(profilesDir, { recursive: true });
    profilePath = path.join(profilesDir, 'Admin.profile-meta.xml');
    await writeFile(profilePath, PROFILE, 'utf8');
    process.chdir(root);
    $$.localPathRetriever = async () => root;
    $$.localPathRetrieverSync = () => root;
    $$.setConfigStubContents('SfProjectJson', {
      contents: { packageDirectories: [{ path: 'force-app', default: true }] },
    });
    $$.fakeConnectionRequest = async (request) => {
      const { url, body } = request as { url: string; body?: string };
      if (url.endsWith('/sobjects/PermissionSet/describe')) {
        return { fields: [{ name: 'Id' }, { name: 'PermissionsApiEnabled' }] };
      }

      if (url.includes('/tooling/query')) {
        return { done: true, totalSize: 0, records: [] };
      }

      const type = /<m:type>([^<]*)<\/m:type>/.exec(body ?? '')?.[1] ?? '';
      return listResponse(ORG[type] ?? []);
    };
  });

  afterEach(async () => {
    process.chdir(initialCwd);
    $$.restore();
    await rm(root, { recursive: true, force: true });
  });

  it('removes the entries referring to components the org lacks, and reports them', async () => {
    const result = await OrgAlign.run(['-o', testOrg.username]);

    expect(result.dryRun).to.equal(false);
    expect(result.files).to.have.length(1);
    expect(result.files[0].removed).to.deep.equal([{ section: 'classAccesses', type: 'ApexClass', name: 'Missing' }]);
    const written = await readFile(profilePath, 'utf8');
    expect(written).to.contain('<apexClass>InOrg</apexClass>').and.contain('<name>ApiEnabled</name>');
    expect(written).not.to.contain('Missing');
    expect(sfCommandStubs.log.lastCall.args[0]).to.contain('1 entries removed from 1 files');
  });

  it('--dry-run leaves the files untouched', async () => {
    const result = await OrgAlign.run(['-o', testOrg.username, '--dry-run']);

    expect(result.dryRun).to.equal(true);
    expect(result.files[0].removed).to.have.length(1);
    expect(await readFile(profilePath, 'utf8')).to.equal(PROFILE);
  });
});
