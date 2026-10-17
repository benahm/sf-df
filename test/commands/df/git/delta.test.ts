import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';

import GitDelta from '../../../../src/commands/df/git/delta.js';

const runGit = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('df git delta', () => {
  const $$ = new TestContext();
  const initialCwd = process.cwd();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  let repoRoot: string;

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    repoRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-command-'));
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.email', 'delta@example.com']);
    runGit(repoRoot, ['config', 'user.name', 'Delta Tests']);

    const classPath = path.join(repoRoot, 'force-app/main/default/classes/MyClass.cls');
    await mkdir(path.dirname(classPath), { recursive: true });
    await writeFile(classPath, 'public class MyClass {}\n', 'utf8');
    await writeFile(
      `${classPath}-meta.xml`,
      '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>61.0</apiVersion><status>Active</status></ApexClass>\n',
      'utf8'
    );
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'base']);
    await writeFile(classPath, 'public class MyClass { }\n', 'utf8');

    // The command diffs the repository it is launched from.
    process.chdir(repoRoot);
  });

  afterEach(async () => {
    process.chdir(initialCwd);
    $$.restore();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('generates the delta and returns the result', async () => {
    const result = await GitDelta.run(['--from', 'HEAD', '--output-dir', 'out']);

    expect(result.processedChanges).to.equal(1);
    expect(result.countsByStrategy).to.deep.equal({ generic: 1 });
    expect(result.packageManifestPath).to.equal(path.join(repoRoot, 'out', 'package', 'package.xml'));
    expect(await readFile(result.packageManifestPath, 'utf8')).to.contain('<members>MyClass</members>');

    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((call) => call.args)
      .join('\n');
    expect(output).to.include('Processed 1 delta operations.');
  });

  it('requires --from', async () => {
    try {
      await GitDelta.run(['--output-dir', 'out']);
      expect.fail('expected a missing flag error');
    } catch (error) {
      expect((error as Error).message).to.include('Missing required flag from');
    }
  });
});
