import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { generateDelta } from '../../src/delta/engine.js';
import { diffCompositeXml } from '../../src/delta/xml.js';

const runGit = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

const writeRepoFile = async (repoRoot: string, relativePath: string, content: string): Promise<void> => {
  const absolutePath = path.join(repoRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
};

const setupRepo = async (): Promise<string> => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-test-'));
  runGit(repoRoot, ['init']);
  runGit(repoRoot, ['config', 'user.email', 'delta@example.com']);
  runGit(repoRoot, ['config', 'user.name', 'Delta Tests']);
  return repoRoot;
};

describe('delta engine', () => {
  let repoRoot: string | undefined;

  afterEach(async () => {
    if (repoRoot) {
      await rm(repoRoot, { recursive: true, force: true });
      repoRoot = undefined;
    }
  });

  it('copies generic metadata files and writes package.xml', async () => {
    repoRoot = await setupRepo();

    await writeRepoFile(
      repoRoot,
      'force-app/main/default/classes/MyClass.cls',
      "public with sharing class MyClass {\n  public static String sayHi() {\n    return 'hi';\n  }\n}\n"
    );
    await writeRepoFile(
      repoRoot,
      'force-app/main/default/classes/MyClass.cls-meta.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>61.0</apiVersion><status>Active</status></ApexClass>\n'
    );

    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'base']);

    await writeRepoFile(
      repoRoot,
      'force-app/main/default/classes/MyClass.cls',
      "public with sharing class MyClass {\n  public static String sayHi() {\n    return 'hello';\n  }\n}\n"
    );

    const outputDir = path.join(repoRoot, 'tmp-output');
    const result = await generateDelta({
      repoRoot,
      from: 'HEAD',
      sourceDir: 'force-app/main/default',
      outputDir,
    });

    const copiedClass = await readFile(
      path.join(outputDir, 'package/force-app/main/default/classes/MyClass.cls'),
      'utf8'
    );
    const copiedMeta = await readFile(
      path.join(outputDir, 'package/force-app/main/default/classes/MyClass.cls-meta.xml'),
      'utf8'
    );
    const packageXml = await readFile(result.packageManifestPath, 'utf8');

    expect(copiedClass).to.contain("return 'hello'");
    expect(copiedMeta).to.contain('<ApexClass');
    expect(packageXml).to.contain('<name>ApexClass</name>');
    expect(packageXml).to.contain('<members>MyClass</members>');
  });

  it('writes partial package and destructive XML for custom labels', async () => {
    repoRoot = await setupRepo();

    await writeRepoFile(
      repoRoot,
      'force-app/main/default/labels/CustomLabels.labels-meta.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n  <labels><fullName>LabelOne</fullName><value>One</value></labels>\n  <labels><fullName>LabelTwo</fullName><value>Two</value></labels>\n</CustomLabels>\n'
    );

    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'base']);

    await writeRepoFile(
      repoRoot,
      'force-app/main/default/labels/CustomLabels.labels-meta.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n  <labels><fullName>LabelTwo</fullName><value>Two updated</value></labels>\n  <labels><fullName>LabelThree</fullName><value>Three</value></labels>\n</CustomLabels>\n'
    );

    const outputDir = path.join(repoRoot, 'tmp-output');
    const result = await generateDelta({
      repoRoot,
      from: 'HEAD',
      sourceDir: 'force-app/main/default',
      outputDir,
    });

    const packageLabels = await readFile(
      path.join(outputDir, 'package/force-app/main/default/labels/CustomLabels.labels-meta.xml'),
      'utf8'
    );
    const destructiveLabels = await readFile(
      path.join(outputDir, 'destructive/force-app/main/default/labels/CustomLabels.labels-meta.xml'),
      'utf8'
    );
    const destructiveManifest = await readFile(result.destructiveManifestPath!, 'utf8');

    expect(packageLabels).to.contain('LabelTwo');
    expect(packageLabels).to.contain('LabelThree');
    expect(packageLabels).not.to.contain('<fullName>LabelOne</fullName>');
    expect(destructiveLabels).to.contain('<fullName>LabelOne</fullName>');
    expect(destructiveManifest).to.contain('<name>CustomLabels</name>');
  });

  it('applies metadata-specific strategies even when sourceDir is custom', async () => {
    repoRoot = await setupRepo();

    await writeRepoFile(
      repoRoot,
      'pkg/main/default/labels/CustomLabels.labels-meta.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n  <labels><fullName>LegacyLabel</fullName><value>Legacy</value></labels>\n  <labels><fullName>SharedLabel</fullName><value>Before</value></labels>\n</CustomLabels>\n'
    );

    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'base']);

    await writeRepoFile(
      repoRoot,
      'pkg/main/default/labels/CustomLabels.labels-meta.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n  <labels><fullName>SharedLabel</fullName><value>After</value></labels>\n  <labels><fullName>NewLabel</fullName><value>New</value></labels>\n</CustomLabels>\n'
    );

    const outputDir = path.join(repoRoot, 'tmp-output');
    await generateDelta({
      repoRoot,
      from: 'HEAD',
      sourceDir: 'pkg/main/default',
      outputDir,
    });

    const packageLabels = await readFile(
      path.join(outputDir, 'package/pkg/main/default/labels/CustomLabels.labels-meta.xml'),
      'utf8'
    );
    const destructiveLabels = await readFile(
      path.join(outputDir, 'destructive/pkg/main/default/labels/CustomLabels.labels-meta.xml'),
      'utf8'
    );

    expect(packageLabels).to.contain('SharedLabel');
    expect(packageLabels).to.contain('NewLabel');
    expect(packageLabels).not.to.contain('LegacyLabel');
    expect(destructiveLabels).to.contain('LegacyLabel');
  });
});

describe('diffCompositeXml', () => {
  it('keeps required singleton fields for profiles', () => {
    const oldXml =
      '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><custom>false</custom><userLicense>Salesforce</userLicense><fieldPermissions><field>Account.Name</field><editable>false</editable><readable>true</readable></fieldPermissions></Profile>';
    const newXml =
      '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><custom>false</custom><userLicense>Salesforce</userLicense><fieldPermissions><field>Account.Name</field><editable>true</editable><readable>true</readable></fieldPermissions></Profile>';

    const diff = diffCompositeXml(
      oldXml,
      newXml,
      'Profile',
      {
        fieldPermissions: { keySelector: (item) => String(item.field ?? '') },
      },
      ['custom', 'userLicense']
    );

    expect(diff.packageXml).to.contain('<custom>false</custom>');
    expect(diff.packageXml).to.contain('<userLicense>Salesforce</userLicense>');
    expect(diff.packageXml).to.contain('<editable>true</editable>');
  });
});
