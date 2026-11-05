import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';

import GitMergePreview from '../../../../src/commands/df/git/merge-preview.js';
import { previewMerge } from '../../../../src/merge/preview.js';

const SOURCE = 'force-app/main/default';

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const labels = (...names: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n${names
    .map(
      (name) =>
        `    <labels>\n        <fullName>${name}</fullName>\n        <language>en_US</language>\n        <protected>false</protected>\n        <shortDescription>${name}</shortDescription>\n        <value>${name}</value>\n    </labels>\n`
    )
    .join('')}</CustomLabels>\n`;

const LABELS = `${SOURCE}/labels/CustomLabels.labels-meta.xml`;

describe('df git merge-preview', () => {
  const $$ = new TestContext();
  const initialCwd = process.cwd();
  let repo: string;

  const write = async (relativePath: string, content: string): Promise<void> => {
    const file = path.join(repo, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  };

  const commitAll = (message: string): string => {
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', message]);
    return git(repo, ['rev-parse', 'HEAD']);
  };

  // `int` holds Invoice.cls and two labels; `feature/a` branches from it.
  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    repo = await mkdtemp(path.join(tmpdir(), 'sf-df-merge-preview-'));
    git(repo, ['init', '-q', '-b', 'int']);
    git(repo, ['config', 'user.email', 'dev@example.com']);
    git(repo, ['config', 'user.name', 'Dev']);
    git(repo, ['config', 'core.autocrlf', 'false']);
    await write('.gitattributes', '*.labels-meta.xml merge=deltaforce\n');
    await write(`${SOURCE}/classes/Invoice.cls`, 'public class Invoice {}\n');
    await write(LABELS, labels('Hello'));
    commitAll('base');
    git(repo, ['checkout', '-q', '-b', 'feature/a']);
    git(repo, ['checkout', '-q', 'int']);
    process.chdir(repo);
  });

  afterEach(async () => {
    process.chdir(initialCwd);
    process.exitCode = undefined;
    $$.restore();
    await rm(repo, { recursive: true, force: true });
  });

  it('creates the merge commit without moving any branch or touching the working tree', async () => {
    git(repo, ['checkout', '-q', 'feature/a']);
    await write(`${SOURCE}/classes/Invoice.cls`, 'public class Invoice { Integer total; }\n');
    const feature = commitAll('feature a');
    git(repo, ['checkout', '-q', 'int']);
    const int = git(repo, ['rev-parse', 'int']);

    const result = await GitMergePreview.run(['--from', 'feature/a', '--into', 'int']);

    expect(result.conflicts).to.deep.equal([]);
    expect(result.alreadyMerged).to.equal(false);
    expect(result.intoCommit).to.equal(int);
    expect(result.fromCommit).to.equal(feature);
    expect(git(repo, ['rev-list', '--parents', '-n', '1', result.commit]).split(' ').slice(1)).to.deep.equal([int, feature]);
    expect(git(repo, ['log', '-1', '--format=%s', result.commit])).to.equal('Merge feature/a into int');
    expect(git(repo, ['show', `${result.commit}:${SOURCE}/classes/Invoice.cls`])).to.contain('Integer total');
    expect(git(repo, ['rev-parse', 'int'])).to.equal(int);
    expect(git(repo, ['rev-parse', 'feature/a'])).to.equal(feature);
    expect(git(repo, ['status', '--porcelain'])).to.equal('');
    expect(process.exitCode).to.equal(undefined);
  });

  it('uses the message given', async () => {
    git(repo, ['checkout', '-q', 'feature/a']);
    await write(`${SOURCE}/classes/Invoice.cls`, 'public class Invoice { Integer total; }\n');
    commitAll('feature a');

    const result = await GitMergePreview.run(['-f', 'feature/a', '-i', 'int', '-m', 'JIRA-123 delivered']);

    expect(git(repo, ['log', '-1', '--format=%s', result.commit])).to.equal('JIRA-123 delivered');
  });

  it('merges the files declared in .gitattributes of --into with the XML merge driver', async () => {
    // Both sides add a label at the same place: a line merge conflicts, the driver doesn't.
    git(repo, ['checkout', '-q', 'feature/a']);
    await write(LABELS, labels('Hello', 'FromFeature'));
    commitAll('feature label');
    git(repo, ['checkout', '-q', 'int']);
    await write(LABELS, labels('Hello', 'FromInt'));
    commitAll('int label');

    // Stands for `sf df git merge-driver run` (tested on its own): writes the merged labels into %A.
    const driver = path.join(repo, '..', `${path.basename(repo)}-driver.cjs`);
    await writeFile(
      driver,
      `require('node:fs').writeFileSync(process.argv[2], ${JSON.stringify(labels('Hello', 'FromFeature', 'FromInt'))});\n`
    );

    let result;
    try {
      result = await previewMerge({
        cwd: repo,
        from: 'feature/a',
        into: 'int',
        driverCommand: `node "${driver.replaceAll('\\', '/')}" %A`,
      });
    } finally {
      await rm(driver, { force: true });
    }

    expect(result.conflicts).to.deep.equal([]);
    const merged = git(repo, ['show', `${result.commit}:${LABELS}`]);
    expect(merged).to.contain('<fullName>FromFeature</fullName>');
    expect(merged).to.contain('<fullName>FromInt</fullName>');
  });

  it('lists the conflicts and exits with code 1', async () => {
    git(repo, ['checkout', '-q', 'feature/a']);
    await write(`${SOURCE}/classes/Invoice.cls`, 'public class Invoice { Integer feature; }\n');
    commitAll('feature a');
    git(repo, ['checkout', '-q', 'int']);
    await write(`${SOURCE}/classes/Invoice.cls`, 'public class Invoice { Integer int; }\n');
    commitAll('int change');

    const result = await GitMergePreview.run(['--from', 'feature/a', '--into', 'int']);

    expect(result.conflicts).to.deep.equal([`${SOURCE}/classes/Invoice.cls`]);
    expect(result.commit).to.equal('');
    expect(process.exitCode).to.equal(1);
  });

  it('returns the tip of --into when --from is already merged', async () => {
    const int = git(repo, ['rev-parse', 'int']);

    const result = await GitMergePreview.run(['--from', 'feature/a', '--into', 'int']);

    expect(result.alreadyMerged).to.equal(true);
    expect(result.commit).to.equal(int);
    expect(process.exitCode).to.equal(undefined);
  });

  it('refuses a ref that is not a commit of the repository', async () => {
    try {
      await GitMergePreview.run(['--from', 'origin/feature/unknown', '--into', 'int']);
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as Error).message).to.equal('--from "origin/feature/unknown" is not a commit of this repository.');
    }
  });
});
