import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { execCmd, TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const tsNodeLoader = pathToFileURL(createRequire(import.meta.url).resolve('ts-node/esm')).href;
const slash = (value: string): string => value.replace(/\\/g, '/');

const labelsXml = (labels: Array<[string, string]>): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n${labels
    .map(([name, value]) => `    <labels>\n        <fullName>${name}</fullName>\n        <value>${value}</value>\n    </labels>\n`)
    .join('')}</CustomLabels>\n`;

// A real `git merge` calls the driver installed by the command. The driver runs this checkout of the plugin
// instead of `sf`, which would run the published one.
describe('df git merge-driver NUTs', () => {
  let session: TestSession;
  let repoRoot: string;
  const labelsPath = 'force-app/main/default/labels/CustomLabels.labels-meta.xml';

  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  const writeLabels = (labels: Array<[string, string]>): void => writeFileSync(path.join(repoRoot, labelsPath), labelsXml(labels));
  const merge = (branch: string): number =>
    spawnSync('git', ['merge', branch, '-m', `merge ${branch}`], {
      cwd: repoRoot,
      env: { ...process.env, TS_NODE_PROJECT: path.join(pluginRoot, 'tsconfig.json') },
    }).status ?? -1;

  // base -> ours on the current branch, base -> theirs on `branch`.
  const prepare = (branch: string, base: Array<[string, string]>, ours: Array<[string, string]>, theirs: Array<[string, string]>): void => {
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', `${branch}-ours`);
    writeLabels(base);
    git('commit', '-q', '-am', 'base');
    git('checkout', '-q', '-b', branch);
    writeLabels(theirs);
    git('commit', '-q', '-am', 'theirs');
    git('checkout', '-q', `${branch}-ours`);
    writeLabels(ours);
    git('commit', '-q', '-am', 'ours');
  };

  before(async () => {
    session = await TestSession.create({ devhubAuthStrategy: 'NONE' });
    repoRoot = path.join(session.dir, 'repo');
    mkdirSync(path.dirname(path.join(repoRoot, labelsPath)), { recursive: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'nut@example.com');
    git('config', 'user.name', 'NUT');
    git('config', 'core.autocrlf', 'false');

    execCmd('df git merge-driver install', { ensureExitCode: 0, cwd: repoRoot });
    git('config', 'merge.deltaforce.driver', [
      'node',
      `--loader ${tsNodeLoader}`,
      '--no-warnings',
      slash(path.join(pluginRoot, 'bin/dev.js')),
      'df git merge-driver run --ancestor %O --current %A --other %B --marker-size %L --path %P',
    ].join(' '));
    writeLabels([]);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });

  after(async () => {
    await session?.clean();
  });

  it('merges changes to neighbouring labels without conflict', () => {
    prepare('neighbours', [['A', 'a'], ['B', 'b']], [['A', 'a1'], ['B', 'b']], [['A', 'a'], ['B', 'b1']]);

    expect(merge('neighbours')).to.equal(0);
    expect(readFileSync(path.join(repoRoot, labelsPath), 'utf8')).to.equal(labelsXml([['A', 'a1'], ['B', 'b1']]));
  });

  it('leaves the file in conflict when both branches change the same label', () => {
    prepare('same', [['A', 'a'], ['B', 'b']], [['A', 'a1'], ['B', 'b']], [['A', 'a2'], ['B', 'b1']]);

    expect(merge('same')).to.equal(1);
    expect(git('status', '--short', labelsPath)).to.match(/^UU /);
    const merged = readFileSync(path.join(repoRoot, labelsPath), 'utf8');
    expect(merged).to.contain('<value>b1</value>');
    expect(merged.slice(merged.indexOf('<<<<<<<'), merged.indexOf('>>>>>>>'))).not.to.contain('<fullName>B</fullName>');
    git('merge', '--abort');
  });
});
