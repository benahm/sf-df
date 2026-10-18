import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { readDeployConfig } from '../../src/deploy/config.js';
import { mapOrg, mappedOrgs, readProjectFile, unmapOrg, withLocalAliases } from '../../src/deploy/org-map.js';

const INT = 'https://example--int.sandbox.my.salesforce.com';
const UAT = 'https://example--uat.sandbox.my.salesforce.com';

describe('org map', () => {
  let repoRoot: string;
  let projectFile: string;

  const writeProject = async (content: string): Promise<void> => writeFile(projectFile, content, 'utf8');
  const readProject = async (): Promise<string> => readFile(projectFile, 'utf8');

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-org-map-'));
    projectFile = path.join(repoRoot, 'sfdx-project.json');
    await writeProject(
      '{\r\n    "packageDirectories": [{ "path": "force-app", "default": true }],\r\n    "sourceApiVersion": "61.0"\r\n}\r\n'
    );
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('shows an empty mapping when nothing is declared yet', async () => {
    expect(mappedOrgs(await readProjectFile(repoRoot))).to.deep.equal([]);
  });

  it('adds the org, keeping the rest of the file, its indentation and line endings', async () => {
    const result = await mapOrg(repoRoot, INT, 'int');

    expect(result).to.deep.include({ action: 'mapped', previousBranch: undefined });
    expect(result.orgs).to.deep.equal([{ url: INT, branch: 'int' }]);
    const content = await readProject();
    expect(content).to.equal(
      [
        '{',
        '    "packageDirectories": [',
        '        {',
        '            "path": "force-app",',
        '            "default": true',
        '        }',
        '    ],',
        '    "sourceApiVersion": "61.0",',
        '    "plugins": {',
        '        "sfdf": {',
        '            "orgs": [',
        '                {',
        `                    "url": "${INT}",`,
        '                    "branch": "int"',
        '                }',
        '            ]',
        '        }',
        '    }',
        '}',
        '',
      ].join('\r\n')
    );
    // The file is what sf df deploy reads.
    expect((await readDeployConfig(repoRoot)).orgs).to.deep.equal([{ url: INT, branch: 'int' }]);
  });

  it('changes the branch of an org already mapped, and keeps the other settings', async () => {
    await writeProject(
      JSON.stringify({ plugins: { sfdf: { remote: 'upstream', orgs: [{ url: INT, branch: 'dev' }] } } })
    );

    const result = await mapOrg(repoRoot, 'https://EXAMPLE--int.sandbox.my.salesforce.com/', 'int');

    expect(result).to.deep.include({ action: 'mapped', previousBranch: 'dev' });
    const config = await readDeployConfig(repoRoot);
    expect(config.orgs).to.deep.equal([{ url: INT, branch: 'int' }]);
    expect(config.remote).to.equal('upstream');
  });

  it('leaves the file untouched when the org is already mapped to the branch', async () => {
    const content = JSON.stringify({ plugins: { sfdf: { orgs: [{ url: INT, branch: 'int' }] } } });
    await writeProject(content);

    expect((await mapOrg(repoRoot, INT, 'int')).action).to.equal('unchanged');
    expect(await readProject()).to.equal(content);
  });

  it('refuses a branch already mapped to another org', async () => {
    await writeProject(JSON.stringify({ plugins: { sfdf: { orgs: [{ url: INT, branch: 'int' }] } } }));

    let error: Error | undefined;
    try {
      await mapOrg(repoRoot, UAT, 'int');
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).to.contain(`already mapped to ${INT}`);
  });

  it('removes an org, and refuses an org that is not mapped', async () => {
    await writeProject(
      JSON.stringify({
        plugins: {
          sfdf: {
            orgs: [
              { url: INT, branch: 'int' },
              { url: UAT, branch: 'uat' },
            ],
          },
        },
      })
    );

    const result = await unmapOrg(repoRoot, INT);

    expect(result).to.deep.include({ action: 'removed', previousBranch: 'int' });
    expect((await readDeployConfig(repoRoot)).orgs).to.deep.equal([{ url: UAT, branch: 'uat' }]);

    let error: Error | undefined;
    try {
      await unmapOrg(repoRoot, INT);
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).to.contain('is not mapped');
  });

  it('shows the local alias of each mapped org, or the username without alias', () => {
    const orgs = withLocalAliases(
      [
        { url: INT, branch: 'int' },
        { url: UAT, branch: 'uat' },
        { url: 'https://example.my.salesforce.com', branch: 'main' },
      ],
      [
        { instanceUrl: `${INT}/`, username: 'me@example.com.int', aliases: ['int'] },
        { instanceUrl: UAT, username: 'me@example.com.uat', aliases: null },
      ]
    );

    expect(orgs.map((org) => org.localAliases)).to.deep.equal([['int'], ['me@example.com.uat'], []]);
  });
});
