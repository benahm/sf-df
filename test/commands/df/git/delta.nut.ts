import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { execCmd, TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';

import type { DeltaResult } from '../../../../src/delta/types.js';

// Runs the real command through the CLI, as a user would. No org is needed: the delta only reads git.
describe('df git delta NUTs', () => {
  let session: TestSession;
  let repoRoot: string;

  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  const write = (relativePath: string, content: string): void => {
    const absolutePath = path.join(repoRoot, 'force-app/main/default', relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  };

  before(async () => {
    session = await TestSession.create({ devhubAuthStrategy: 'NONE' });
    repoRoot = path.join(session.dir, 'repo');
    mkdirSync(repoRoot);
    git('init', '-q');
    git('config', 'user.email', 'nut@example.com');
    git('config', 'user.name', 'NUT');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(path.join(repoRoot, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app' }], sourceApiVersion: '64.0' }));
    write('classes/Kept.cls', 'public class Kept {}\n');
    write('classes/Kept.cls-meta.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>64.0</apiVersion><status>Active</status></ApexClass>\n');
    write('classes/Gone.cls', 'public class Gone {}\n');
    write('classes/Gone.cls-meta.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>64.0</apiVersion><status>Active</status></ApexClass>\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    write('classes/Kept.cls', 'public class Kept { }\n');
    git('rm', '-q', 'force-app/main/default/classes/Gone.cls', 'force-app/main/default/classes/Gone.cls-meta.xml');
    git('commit', '-q', '-am', 'change');
  });

  after(async () => {
    await session?.clean();
  });

  it('writes the package and destructive manifests and returns the result as JSON', () => {
    const result = execCmd<DeltaResult>('df git delta --from HEAD~1 --to HEAD --deploy-dir deploy --destructive-dir destructive --json', {
      ensureExitCode: 0,
      cwd: repoRoot,
    }).jsonOutput?.result;

    // Counted per file: the class and its -meta.xml.
    expect(result?.countsByStatus).to.deep.equal({ add: 0, modify: 1, delete: 2, rename: 0 });
    expect(readFileSync(result!.packageManifestPath, 'utf8')).to.contain('<members>Kept</members>');
    expect(readFileSync(result!.destructiveManifestPath!, 'utf8')).to.contain('<members>Gone</members>');
  });

  it('requires --from', () => {
    const output = execCmd('df git delta --deploy-dir deploy', { ensureExitCode: 2, cwd: repoRoot }).shellOutput.stderr;

    expect(output).to.contain('Missing required flag from');
  });
});
