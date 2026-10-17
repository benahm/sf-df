import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';

import ProfileRetrieve from '../../../../src/commands/df/profile/retrieve.js';
import { readMetadataResponse } from '../../../retrieve/fake-org.js';

const STUB = '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"/>\n';

describe('df profile retrieve', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  let root: string;
  let profilesDir: string;
  let requestedUrls: string[];

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    // Earlier command tests may have failed on purpose and left an exit code.
    process.exitCode = undefined;
    await $$.stubAuths(testOrg);
    root = await mkdtemp(path.join(tmpdir(), 'sf-df-profile-command-'));
    profilesDir = path.join(root, 'profiles');
    await mkdir(profilesDir);
    requestedUrls = [];
    $$.fakeConnectionRequest = async (request) => {
      const { url, body } = request as { url: string; body: string };
      requestedUrls.push(url);
      return body.includes('<m:fullNames>Admin</m:fullNames>')
        ? readMetadataResponse('<fullName>Admin</fullName><custom>false</custom>')
        : readMetadataResponse(undefined);
    };
  });

  afterEach(async () => {
    $$.restore();
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('retrieves the profiles and returns their status', async () => {
    const adminPath = path.join(profilesDir, 'Admin.profile-meta.xml');
    await writeFile(adminPath, STUB, 'utf8');

    const result = await ProfileRetrieve.run([
      '--source-dir',
      profilesDir,
      '--target-org',
      testOrg.username,
      '--api-version',
      '62.0',
    ]);

    expect(result.profiles).to.deep.equal([{ fullName: 'Admin', filePath: adminPath, status: 'retrieved' }]);
    expect(await readFile(adminPath, 'utf8')).to.contain('    <custom>false</custom>\n');
    expect(requestedUrls.filter((url) => url.includes('/services/Soap/m/'))).to.have.length(1);
    expect(requestedUrls.find((url) => url.includes('/services/Soap/m/'))).to.match(/\/services\/Soap\/m\/62\.0$/);
    expect(process.exitCode).to.equal(undefined);
  });

  it('warns and exits with 1 when a profile is missing from the org', async () => {
    await writeFile(path.join(profilesDir, 'Ghost.profile-meta.xml'), STUB, 'utf8');

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
});
