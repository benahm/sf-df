import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';

import MergeDriverInstall from '../../../../src/commands/df/git/merge-driver/install.js';
import MergeDriverRun from '../../../../src/commands/df/git/merge-driver/run.js';
import MergeDriverUninstall from '../../../../src/commands/df/git/merge-driver/uninstall.js';
import { pathExists } from '../../../../src/delta/fs.js';
import type { MergeDriverResult } from '../../../../src/merge/driver.js';
import { mergeDriverPatterns } from '../../../../src/merge/merge-rules.js';

const runGit = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('df git merge-driver', () => {
  const $$ = new TestContext();
  const initialCwd = process.cwd();
  let repoRoot: string;
  let gitattributes: string;

  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    repoRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-merge-driver-'));
    gitattributes = path.join(repoRoot, '.gitattributes');
    runGit(repoRoot, ['init', '-q']);
    process.chdir(repoRoot);
  });

  afterEach(async () => {
    process.chdir(initialCwd);
    process.exitCode = undefined;
    $$.restore();
    await rm(repoRoot, { recursive: true, force: true });
  });

  describe('install', () => {
    it('configures the driver and declares the files it handles', async () => {
      const result = await MergeDriverInstall.run([]);

      expect(runGit(repoRoot, ['config', '--get', 'merge.deltaforce.driver'])).to.equal(
        'sf df git merge-driver run --ancestor %O --current %A --other %B --marker-size %L --path %P'
      );
      expect(result.addedPatterns).to.deep.equal(mergeDriverPatterns());
      expect(runGit(repoRoot, ['check-attr', 'merge', '--', 'force-app/main/default/profiles/Admin.profile-meta.xml'])).to.equal(
        'force-app/main/default/profiles/Admin.profile-meta.xml: merge: deltaforce'
      );
      expect(runGit(repoRoot, ['check-attr', 'merge', '--', 'force-app/main/default/classes/A.cls-meta.xml'])).to.match(
        /merge: unspecified$/
      );
    });

    it('keeps the existing .gitattributes and only adds what is missing', async () => {
      await writeFile(gitattributes, '* text=auto\r\n*.profile-meta.xml merge=deltaforce\r\n');

      const result = await MergeDriverInstall.run([]);
      const content = await readFile(gitattributes, 'utf8');

      expect(result.addedPatterns).not.to.include('*.profile-meta.xml');
      expect(content.startsWith('* text=auto\r\n*.profile-meta.xml merge=deltaforce\r\n\r\n# Salesforce')).to.equal(true);
      expect(content.match(/\*\.profile-meta\.xml/g)).to.have.length(1);
      expect(content.replace(/\r\n/g, '')).not.to.contain('\n');

      expect((await MergeDriverInstall.run([])).addedPatterns).to.deep.equal([]);
      expect(await readFile(gitattributes, 'utf8')).to.equal(content);
    });
  });

  describe('uninstall', () => {
    it('removes the driver and its lines, and keeps the rest of .gitattributes', async () => {
      await writeFile(gitattributes, '* text=auto\n');
      await MergeDriverInstall.run([]);

      const result = await MergeDriverUninstall.run([]);

      expect(result.removedPatterns).to.deep.equal(mergeDriverPatterns());
      expect(await readFile(gitattributes, 'utf8')).to.equal('* text=auto\n');
      expect(() => runGit(repoRoot, ['config', '--get', 'merge.deltaforce.driver'])).to.throw();
    });

    it('deletes .gitattributes when nothing else is left in it', async () => {
      await MergeDriverInstall.run([]);
      await MergeDriverUninstall.run([]);

      expect(await pathExists(gitattributes)).to.equal(false);
    });
  });

  describe('run', () => {
    const labels = (value: string): string =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n    <labels>\n        <fullName>A</fullName>\n        <value>${value}</value>\n    </labels>\n</CustomLabels>\n`;

    const runDriver = async (ours: string, theirs: string): Promise<MergeDriverResult> => {
      await Promise.all([writeFile('O', labels('a')), writeFile('A', labels(ours)), writeFile('B', labels(theirs))]);
      return MergeDriverRun.run(['--ancestor', 'O', '--current', 'A', '--other', 'B', '--marker-size', '7', '--path', 'CustomLabels.labels-meta.xml']);
    };

    it('exits with code 0 when the merge is clean', async () => {
      expect(await runDriver('a', 'a2')).to.deep.equal({ path: 'CustomLabels.labels-meta.xml', strategy: 'xml', conflicts: 0 });
      expect(process.exitCode).to.equal(undefined);
      expect(await readFile('A', 'utf8')).to.equal(labels('a2'));
    });

    it('exits with code 1 when conflicts are left, so git reports the file as conflicted', async () => {
      expect((await runDriver('a1', 'a2')).conflicts).to.equal(1);
      expect(process.exitCode).to.equal(1);
    });
  });
});
