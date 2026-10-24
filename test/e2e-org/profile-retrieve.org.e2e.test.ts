import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Org } from '@salesforce/core';
import { describe, it, expect, afterAll } from 'vitest';

import { retrieveProfiles } from '../../src/retrieve/profile-retrieve.js';
import { runSf } from './org-state.js';

// `sf df profile retrieve` against a real org, read only: nothing is deployed.
//
//   RUN_E2E_ORG=true E2E_TARGET_ORG=<sandbox alias> npm run test:e2e:org
//
// A profile retrieved by `sf project retrieve start` together with some components holds only the accesses to
// those components. Every element of that file must be found, unchanged and in the same order, in the complete
// profile written by the command.

const targetOrg = process.env.E2E_TARGET_ORG;
const profileName = process.env.E2E_ORG_PROFILE ?? 'Admin';
const enabled = process.env.RUN_E2E_ORG === 'true' && Boolean(targetOrg);
const API = '64.0';

const topLevelElements = (xml: string): string[] =>
  [...xml.matchAll(/^ {4}<(\w+)>[\s\S]*?^ {4}<\/\1>$|^ {4}<(\w+)>.*<\/\2>$/gm)].map((match) => match[0]);

describe.skipIf(!enabled)('sf df profile retrieve on a real org', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'sf-df-e2e-profile-'));

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('writes the complete profile, a superset of what sf project retrieve writes', async () => {
    writeFileSync(
      path.join(work, 'sfdx-project.json'),
      JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: API })
    );
    mkdirSync(path.join(work, 'force-app'), { recursive: true });
    runSf(
      [
        'project',
        'retrieve',
        'start',
        '-m',
        `Profile:${profileName}`,
        '-m',
        'CustomObject:Account',
        '-m',
        'ApexClass',
        '-o',
        targetOrg!,
        '--json',
      ],
      work
    );
    const nativePath = path.join(work, 'force-app/main/default/profiles', `${profileName}.profile-meta.xml`);
    const native = readFileSync(nativePath, 'utf8');

    const connection = (await Org.create({ aliasOrUsername: targetOrg })).getConnection(API);
    const outputDir = path.join(work, 'out');
    const result = await retrieveProfiles({ connection, sourcePath: nativePath, outputDir });

    expect(result.profiles).toEqual([
      { fullName: profileName, filePath: path.join(outputDir, 'profiles', path.basename(nativePath)), status: 'retrieved' },
    ]);
    const complete = readFileSync(result.profiles[0].filePath, 'utf8');
    const nativeElements = topLevelElements(native);
    const completeElements = topLevelElements(complete);
    const positions = nativeElements.map((element) => completeElements.indexOf(element));

    expect(complete.split('\n').slice(0, 2)).toEqual(native.split('\n').slice(0, 2));
    expect(nativeElements.filter((_, index) => positions[index] === -1)).toEqual([]);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(completeElements.length).toBeGreaterThan(nativeElements.length);
  });

  it('leaves the file of a profile missing from the org untouched', async () => {
    const ghostPath = path.join(work, 'ghost', 'SfDfQa Ghost Profile.profile-meta.xml');
    mkdirSync(path.dirname(ghostPath), { recursive: true });
    const stub = '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"/>\n';
    writeFileSync(ghostPath, stub);

    const connection = (await Org.create({ aliasOrUsername: targetOrg })).getConnection(API);
    const result = await retrieveProfiles({ connection, sourcePath: ghostPath });

    expect(result.profiles[0].status).toBe('notFound');
    expect(readFileSync(ghostPath, 'utf8')).toBe(stub);
  });
});
