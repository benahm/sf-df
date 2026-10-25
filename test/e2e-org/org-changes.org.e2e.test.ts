import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Org } from '@salesforce/core';
import { describe, it, expect, afterAll } from 'vitest';

import { changesManifest, listOrgChanges, type OrgChangesOptions } from '../../src/changes/org-changes.js';
import { orgChangesSources } from '../../src/changes/org-sources.js';
import { parseSfJson, runSf } from './org-state.js';

// `sf df org changes` against a real org: a class deployed now is the newest change of its author, its manifest
// retrieves it, and once deleted it is listed as deleted when the org has source tracking.
//
//   RUN_E2E_ORG=true E2E_TARGET_ORG=<org alias> npm run test:e2e:org
//
// Deploys an Apex class named SfDfQa*, and deletes it.

const targetOrg = process.env.E2E_TARGET_ORG;
const enabled = process.env.RUN_E2E_ORG === 'true' && Boolean(targetOrg);
const API = '64.0';

const runJson = (args: string[], cwd: string): { status: number; result?: unknown; message?: string } =>
  parseSfJson(runSf([...args, '-o', targetOrg!, '--json'], cwd));

describe.skipIf(!enabled)('sf df org changes on a real org', () => {
  const className = `SfDfQaChanges${Date.now().toString(36).slice(-5)}`;
  const work = mkdtempSync(path.join(tmpdir(), 'sf-df-e2e-changes-'));
  const classes = path.join(work, 'force-app', 'main', 'default', 'classes');
  let deployed = false;

  afterAll(() => {
    if (deployed) {
      runJson(['project', 'delete', 'source', '-m', `ApexClass:${className}`, '--no-prompt'], work);
    }

    rmSync(work, { recursive: true, force: true });
  });

  it('lists a deployed class first, retrieves it from the manifest, then lists its deletion', async () => {
    writeFileSync(
      path.join(work, 'sfdx-project.json'),
      JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: API })
    );
    mkdirSync(classes, { recursive: true });
    writeFileSync(path.join(classes, `${className}.cls`), `public with sharing class ${className} {}\n`);
    writeFileSync(
      path.join(classes, `${className}.cls-meta.xml`),
      `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
        `    <apiVersion>${API}</apiVersion>\n    <status>Active</status>\n</ApexClass>\n`
    );

    const org = await Org.create({ aliasOrUsername: targetOrg });
    const connection = org.getConnection(API);
    // The auth file of an org doesn't always hold the user Id.
    const me = (await connection.query<{ Id: string }>(`SELECT Id FROM User WHERE Username = '${org.getUsername()!}'`))
      .records[0].Id;
    // The clocks of the org and of this machine may differ by a few seconds.
    const since = new Date(Date.now() - 5 * 60 * 1000);
    const options = (): OrgChangesOptions => ({
      sources: orgChangesSources(connection),
      since,
      users: [me],
      types: ['ApexClass'],
    });

    const deploy = runJson(['project', 'deploy', 'start', '-d', 'force-app', '-w', '30'], work);
    expect(deploy.status, JSON.stringify(deploy)).toBe(0);
    deployed = true;

    const afterDeploy = await listOrgChanges(options());
    const listed = afterDeploy.changes.find((change) => change.fullName === className);
    expect(listed, JSON.stringify(afterDeploy.changes)).toMatchObject({
      type: 'ApexClass',
      status: 'changed',
      lastModifiedById: expect.stringMatching(new RegExp(`^${me.slice(0, 15)}`)),
    });

    // The manifest retrieves the class into an empty project.
    const retrieved = path.join(work, 'retrieved');
    mkdirSync(path.join(retrieved, 'force-app'), { recursive: true });
    writeFileSync(
      path.join(retrieved, 'sfdx-project.json'),
      JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: API })
    );
    writeFileSync(path.join(retrieved, 'changes.xml'), changesManifest([listed!], API));
    const retrieve = runJson(['project', 'retrieve', 'start', '-x', 'changes.xml', '-w', '30'], retrieved);
    expect(retrieve.status, JSON.stringify(retrieve)).toBe(0);
    expect(existsSync(path.join(retrieved, 'force-app', 'main', 'default', 'classes', `${className}.cls`))).toBe(true);

    const deletion = runJson(['project', 'delete', 'source', '-m', `ApexClass:${className}`, '--no-prompt'], work);
    expect(deletion.status, JSON.stringify(deletion)).toBe(0);
    deployed = false;

    const afterDelete = await listOrgChanges(options());
    const deleted = afterDelete.changes.find((change) => change.fullName === className);
    if (afterDelete.tracking) {
      expect(deleted, JSON.stringify(afterDelete.changes)).toMatchObject({ status: 'deleted', source: 'tracking' });
    } else {
      // Without source tracking, a deleted component simply disappears.
      expect(deleted).toBeUndefined();
    }
  });
});
