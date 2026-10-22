import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { retrieveProfiles } from '../../src/retrieve/profile-retrieve.js';
import { fakeConnection } from './fake-org.js';

const PROFILES_DIR = 'force-app/main/default/profiles';
const STUB = '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"/>\n';

describe('retrieveProfiles', () => {
  let root: string;
  let profilesDir: string;

  const writeProfile = async (fileName: string, content = STUB): Promise<string> => {
    const filePath = path.join(profilesDir, fileName);
    await writeFile(filePath, content, 'utf8');
    return filePath;
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sf-df-profile-retrieve-'));
    profilesDir = path.join(root, PROFILES_DIR);
    await mkdir(profilesDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('overwrites each profile with the complete profile of the org', async () => {
    const adminPath = await writeProfile('Admin.profile-meta.xml');

    const result = await retrieveProfiles({
      connection: fakeConnection({
        Admin: '<custom>false</custom><userLicense>Salesforce</userLicense>',
      }),
      sourcePath: profilesDir,
    });

    expect(result.profiles).to.deep.equal([{ fullName: 'Admin', filePath: adminPath, status: 'retrieved' }]);
    expect(await readFile(adminPath, 'utf8')).to.equal(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n    <custom>false</custom>\n    <userLicense>Salesforce</userLicense>\n</Profile>\n'
    );
  });

  it('writes into <output-dir>/profiles and leaves the source untouched', async () => {
    const adminPath = await writeProfile('Admin.profile-meta.xml');
    const outputDir = path.join(root, 'out');

    const result = await retrieveProfiles({
      connection: fakeConnection({ Admin: '<custom>false</custom>' }),
      sourcePath: adminPath,
      outputDir,
    });

    expect(result.profiles[0].filePath).to.equal(path.join(outputDir, 'profiles', 'Admin.profile-meta.xml'));
    expect(await readFile(path.join(outputDir, 'profiles', 'Admin.profile-meta.xml'), 'utf8')).to.contain(
      '<custom>false</custom>'
    );
    expect(await readFile(adminPath, 'utf8')).to.equal(STUB);
  });

  it('isolates a failing profile: the others are still written', async () => {
    await writeProfile('Admin.profile-meta.xml');
    const brokenPath = await writeProfile('Broken.profile-meta.xml');

    const result = await retrieveProfiles({
      connection: fakeConnection({
        Admin: '<custom>false</custom>',
        Broken: new Error('INVALID_TYPE: not a transient error'),
      }),
      sourcePath: profilesDir,
    });

    expect(result.profiles.map(({ fullName, status, error }) => ({ fullName, status, error }))).to.deep.equal([
      { fullName: 'Admin', status: 'retrieved', error: undefined },
      { fullName: 'Broken', status: 'failed', error: 'INVALID_TYPE: not a transient error' },
    ]);
    expect(await readFile(brokenPath, 'utf8')).to.equal(STUB);
    expect(await readdir(profilesDir)).to.deep.equal(['Admin.profile-meta.xml', 'Broken.profile-meta.xml']);
  });

  it('retries a transient error, then gives up', async () => {
    await writeProfile('Admin.profile-meta.xml');
    await writeProfile('Broken.profile-meta.xml');
    const calls: string[][] = [];
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

    const result = await retrieveProfiles({
      connection: fakeConnection({ Admin: '<custom>false</custom>', Broken: new Error('socket hang up') }, calls, {
        onRequest: async () => {
          // The first call for Admin drops.
          if (calls.filter(([name]) => name === 'Admin').length === 1 && calls.at(-1)?.[0] === 'Admin') {
            throw reset;
          }
        },
      }),
      sourcePath: profilesDir,
      concurrency: 1,
      retries: 2,
      retryDelayMs: 0,
    });

    expect(result.profiles.map(({ status }) => status)).to.deep.equal(['retrieved', 'failed']);
    expect(calls).to.deep.equal([['Admin'], ['Admin'], ['Broken'], ['Broken'], ['Broken']]);
  });

  it('refreshes an expired session once and retries', async () => {
    await writeProfile('Admin.profile-meta.xml');
    const calls: string[][] = [];

    const result = await retrieveProfiles({
      connection: fakeConnection({ Admin: '<custom>false</custom>' }, calls, { expiredOnce: true }),
      sourcePath: profilesDir,
    });

    expect(result.profiles[0].status).to.equal('retrieved');
    expect(calls).to.deep.equal([['Admin'], ['Admin']]);
  });

  it('shares one session refresh between the parallel calls', async () => {
    const names = ['A', 'B', 'C'];
    await Promise.all(names.map((name) => writeProfile(`${name}.profile-meta.xml`)));
    let refreshes = 0;

    const result = await retrieveProfiles({
      connection: fakeConnection(Object.fromEntries(names.map((name) => [name, '<custom>true</custom>'])), [], {
        expiredOnce: true,
        onRequest: () => new Promise((resolve) => setTimeout(resolve, 5)),
        onRefresh: () => {
          refreshes += 1;
        },
      }),
      sourcePath: profilesDir,
      concurrency: 3,
    });

    expect(result.profiles.map(({ status }) => status)).to.deep.equal(['retrieved', 'retrieved', 'retrieved']);
    expect(refreshes).to.equal(1);
  });

  it('reports the progress of each profile', async () => {
    await writeProfile('A.profile-meta.xml');
    await writeProfile('B.profile-meta.xml');
    const progress: string[] = [];

    await retrieveProfiles({
      connection: fakeConnection({ A: '<custom>true</custom>' }),
      sourcePath: profilesDir,
      onProgress: (profile, done, total) => progress.push(`${profile.fullName} ${profile.status} ${done}/${total}`),
      concurrency: 1,
    });

    expect(progress).to.deep.equal(['A retrieved 1/2', 'B notFound 2/2']);
  });

  it('reads one profile per call, with at most `concurrency` calls in flight', async () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    await Promise.all(names.map((name) => writeProfile(`${name}.profile-meta.xml`)));
    const calls: string[][] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await retrieveProfiles({
      connection: fakeConnection(Object.fromEntries(names.map((name) => [name, '<custom>true</custom>'])), calls, {
        onRequest: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
        },
      }),
      sourcePath: profilesDir,
      concurrency: 3,
    });

    expect(result.profiles.map((profile) => profile.fullName)).to.deep.equal(names);
    expect(calls.every((call) => call.length === 1)).to.equal(true);
    expect(maxInFlight).to.equal(3);
  });
});
