import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import ansis from 'ansis';
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
    const result = await GitDelta.run(['--from', 'HEAD', '--deploy-dir', 'deploy', '--destructive-dir', 'destructive']);

    expect(result.processedChanges).to.equal(1);
    expect(result.countsByStrategy).to.deep.equal({ generic: 1 });
    expect(result.packageManifestPath).to.equal(path.join(repoRoot, 'deploy', 'package.xml'));
    expect(result.destructiveDir).to.equal(path.join(repoRoot, 'destructive'));
    expect(await readFile(result.packageManifestPath, 'utf8')).to.contain('<members>MyClass</members>');

    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((call) => call.args)
      .join('\n');
    expect(output).to.include('1 changed file: 1 modified.');
    const rows = sfCommandStubs.table.firstCall.args[0].data.map((data) => ansis.strip(Object.values(data).join(' | ')));
    expect(rows).to.deep.equal(['~ Modified | ApexClass | MyClass | classes/MyClass.cls']);
  });

  it('requires --from', async () => {
    try {
      await GitDelta.run(['--deploy-dir', 'deploy']);
      expect.fail('expected a missing flag error');
    } catch (error) {
      expect((error as Error).message).to.include('Missing required flag from');
    }
  });

  it('writes the destructive changes next to the deploy directory by default', async () => {
    const result = await GitDelta.run(['--from', 'HEAD', '--deploy-dir', 'deploy']);

    expect(result.destructiveDir).to.equal(path.join(repoRoot, 'deploy-destructive'));
  });

  it('accepts the sfdx mdt:git:delta flag names', async () => {
    const result = await GitDelta.run(['--from', 'HEAD', '--packagedir', 'deploy', '--descructivedir', 'destructive']);

    expect(result.packageDir).to.equal(path.join(repoRoot, 'deploy'));
    expect(result.destructiveDir).to.equal(path.join(repoRoot, 'destructive'));
  });

  it('refuses a destructive directory inside the deploy directory', async () => {
    try {
      await GitDelta.run(['--from', 'HEAD', '--deploy-dir', 'deploy', '--destructive-dir', 'deploy/destructive']);
      expect.fail('expected the nested directories to be refused');
    } catch (error) {
      expect((error as Error).message).to.include('must not contain each other');
    }
  });
});
