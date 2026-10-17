import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { generateDelta } from '../../src/delta/engine.js';
import type { DeltaResult } from '../../src/delta/types.js';

// Behaviours carried over from `sfdx mdt:git:delta` (benahm/sfdx-mdt-plugin).

const SOURCE_DIR = 'force-app/main/default';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const runGit = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

const writeRepoFiles = async (repoRoot: string, files: Record<string, string>): Promise<void> => {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(repoRoot, SOURCE_DIR, relativePath);
    // eslint-disable-next-line no-await-in-loop
    await mkdir(path.dirname(absolutePath), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await writeFile(absolutePath, content, 'utf8');
  }
};

const exists = async (absolutePath: string): Promise<boolean> =>
  stat(absolutePath).then(
    () => true,
    () => false
  );

describe('mdt:git:delta parity', () => {
  let repoRoot: string;
  let outputDir: string;

  const commitBaseline = async (files: Record<string, string>): Promise<void> => {
    await writeRepoFiles(repoRoot, files);
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'base']);
  };

  const runDelta = (): Promise<DeltaResult> => generateDelta({ repoRoot, from: 'HEAD', sourceDir: SOURCE_DIR, deployDir: path.join(outputDir, 'package'), destructiveDir: path.join(outputDir, 'destructive') });

  const readPackage = (relativePath: string): Promise<string> =>
    readFile(path.join(outputDir, 'package', SOURCE_DIR, relativePath), 'utf8');
  const readDestructive = (relativePath: string): Promise<string> =>
    readFile(path.join(outputDir, 'destructive', SOURCE_DIR, relativePath), 'utf8');
  const packageHas = (relativePath: string): Promise<boolean> =>
    exists(path.join(outputDir, 'package', SOURCE_DIR, relativePath));

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-parity-'));
    outputDir = path.join(repoRoot, 'tmp-output');
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.email', 'delta@example.com']);
    runGit(repoRoot, ['config', 'user.name', 'Delta Tests']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('writes partial sharing rules and lists deleted rules by child type', async () => {
    const rule = (name: string, label: string): string =>
      `<sharingCriteriaRules><fullName>${name}</fullName><accessLevel>Read</accessLevel><label>${label}</label></sharingCriteriaRules>`;
    const file = 'sharingRules/Account.sharingRules-meta.xml';

    await commitBaseline({
      [file]: `${XML_HEADER}<SharingRules ${NS}>${rule('Kept', 'Kept')}${rule('Changed', 'Before')}${rule('Removed', 'Removed')}</SharingRules>\n`,
    });
    await writeRepoFiles(repoRoot, {
      [file]: `${XML_HEADER}<SharingRules ${NS}>${rule('Kept', 'Kept')}${rule('Changed', 'After')}${rule('Added', 'Added')}</SharingRules>\n`,
    });

    const result = await runDelta();
    const packageXml = await readPackage(file);
    const destructiveXml = await readDestructive(file);
    const destructiveManifest = await readFile(result.destructiveManifestPath!, 'utf8');

    expect(result.countsByStrategy).to.have.property('sharingRules');
    expect(packageXml).to.contain('<fullName>Changed</fullName>');
    expect(packageXml).to.contain('<fullName>Added</fullName>');
    expect(packageXml).not.to.contain('<fullName>Kept</fullName>');
    expect(destructiveXml).to.contain('<fullName>Removed</fullName>');
    expect(destructiveManifest).to.contain('<name>SharingCriteriaRule</name>');
    expect(destructiveManifest).to.contain('<members>Account.Removed</members>');
    expect(destructiveManifest).not.to.contain('<name>SharingRules</name>');
    expect(await readFile(path.join(outputDir, 'destructive/package.xml'), 'utf8')).not.to.contain('<types>');
  });

  for (const [typeName, directory, suffix, element] of [
    ['AssignmentRules', 'assignmentRules', 'assignmentRules', 'assignmentRule'],
    ['AutoResponseRules', 'autoResponseRules', 'autoResponseRules', 'autoResponseRule'],
    ['MatchingRules', 'matchingRules', 'matchingRule', 'matchingRules'],
  ] as const) {
    it(`writes partial ${typeName} XML`, async () => {
      const item = (name: string, active: string): string =>
        `<${element}><fullName>${name}</fullName><active>${active}</active></${element}>`;
      const file = `${directory}/Case.${suffix}-meta.xml`;

      await commitBaseline({
        [file]: `${XML_HEADER}<${typeName} ${NS}>${item('Stable', 'true')}${item('Toggled', 'false')}${item('Dropped', 'true')}</${typeName}>\n`,
      });
      await writeRepoFiles(repoRoot, {
        [file]: `${XML_HEADER}<${typeName} ${NS}>${item('Stable', 'true')}${item('Toggled', 'true')}</${typeName}>\n`,
      });

      const result = await runDelta();
      const packageXml = await readPackage(file);
      const destructiveManifest = await readFile(result.destructiveManifestPath!, 'utf8');

      expect(packageXml).to.contain('<fullName>Toggled</fullName>');
      expect(packageXml).not.to.contain('<fullName>Stable</fullName>');
      expect(await readDestructive(file)).to.contain('<fullName>Dropped</fullName>');
      expect(destructiveManifest).to.contain('<members>Case.Dropped</members>');
    });
  }

  it('lists deleted workflow rules by child type', async () => {
    const rule = (name: string): string =>
      `<rules><fullName>${name}</fullName><active>true</active><triggerType>onCreateOnly</triggerType></rules>`;
    const file = 'workflows/Account.workflow-meta.xml';

    await commitBaseline({ [file]: `${XML_HEADER}<Workflow ${NS}>${rule('Keep')}${rule('Drop')}</Workflow>\n` });
    await writeRepoFiles(repoRoot, { [file]: `${XML_HEADER}<Workflow ${NS}>${rule('Keep')}</Workflow>\n` });

    const result = await runDelta();
    const destructiveManifest = await readFile(result.destructiveManifestPath!, 'utf8');

    expect(destructiveManifest).to.contain('<name>WorkflowRule</name>');
    expect(destructiveManifest).to.contain('<members>Account.Drop</members>');
  });

  it('copies the whole LWC bundle without __tests__', async () => {
    await commitBaseline({
      'lwc/myCmp/myCmp.js': 'export default class MyCmp {}\n',
      'lwc/myCmp/myCmp.html': '<template></template>\n',
      'lwc/myCmp/myCmp.js-meta.xml': `${XML_HEADER}<LightningComponentBundle ${NS}><apiVersion>61.0</apiVersion></LightningComponentBundle>\n`,
      'lwc/myCmp/__tests__/myCmp.test.js': "describe('myCmp', () => {});\n",
    });
    await writeRepoFiles(repoRoot, { 'lwc/myCmp/myCmp.js': 'export default class MyCmp { updated = true; }\n' });

    const result = await runDelta();

    expect(await packageHas('lwc/myCmp/myCmp.js')).to.equal(true);
    expect(await packageHas('lwc/myCmp/myCmp.html')).to.equal(true);
    expect(await packageHas('lwc/myCmp/myCmp.js-meta.xml')).to.equal(true);
    expect(await packageHas('lwc/myCmp/__tests__/myCmp.test.js')).to.equal(false);
    expect(await readFile(result.packageManifestPath, 'utf8')).to.contain('<members>myCmp</members>');
  });

  it('copies the parent object translation with a changed field translation', async () => {
    const fieldTranslation = (label: string): string =>
      `${XML_HEADER}<CustomFieldTranslation ${NS}><label>${label}</label><name>Amount__c</name></CustomFieldTranslation>\n`;
    await commitBaseline({
      'objectTranslations/Invoice__c-fr/Invoice__c-fr.objectTranslation-meta.xml': `${XML_HEADER}<CustomObjectTranslation ${NS}><caseValues><plural>false</plural><value>Facture</value></caseValues></CustomObjectTranslation>\n`,
      'objectTranslations/Invoice__c-fr/Amount__c.fieldTranslation-meta.xml': fieldTranslation('Montant'),
    });
    await writeRepoFiles(repoRoot, {
      'objectTranslations/Invoice__c-fr/Amount__c.fieldTranslation-meta.xml': fieldTranslation('Montant TTC'),
    });

    const result = await runDelta();

    expect(await readPackage('objectTranslations/Invoice__c-fr/Amount__c.fieldTranslation-meta.xml')).to.contain(
      'Montant TTC'
    );
    expect(await packageHas('objectTranslations/Invoice__c-fr/Invoice__c-fr.objectTranslation-meta.xml')).to.equal(
      true
    );
    expect(await readFile(result.packageManifestPath, 'utf8')).to.contain('<members>Invoice__c-fr</members>');
  });

  it('copies a folder static resource with its meta file', async () => {
    await commitBaseline({
      'staticresources/assets.resource-meta.xml': `${XML_HEADER}<StaticResource ${NS}><cacheControl>Private</cacheControl><contentType>application/zip</contentType></StaticResource>\n`,
      'staticresources/assets/css/app.css': 'body { color: red; }\n',
      'staticresources/assets/js/app.js': 'console.log(1);\n',
    });
    await writeRepoFiles(repoRoot, { 'staticresources/assets/css/app.css': 'body { color: blue; }\n' });

    await runDelta();

    expect(await readPackage('staticresources/assets/css/app.css')).to.contain('blue');
    expect(await packageHas('staticresources/assets/js/app.js')).to.equal(true);
    expect(await packageHas('staticresources/assets.resource-meta.xml')).to.equal(true);
  });

  it('copies the source file when only its meta file changed', async () => {
    const meta = (version: string): string =>
      `${XML_HEADER}<ApexClass ${NS}><apiVersion>${version}</apiVersion><status>Active</status></ApexClass>\n`;
    await commitBaseline({
      'classes/MyClass.cls': 'public class MyClass {}\n',
      'classes/MyClass.cls-meta.xml': meta('60.0'),
    });
    await writeRepoFiles(repoRoot, { 'classes/MyClass.cls-meta.xml': meta('61.0') });

    await runDelta();

    expect(await packageHas('classes/MyClass.cls')).to.equal(true);
    expect(await readPackage('classes/MyClass.cls-meta.xml')).to.contain('61.0');
  });

  it('uses sourceApiVersion from sfdx-project.json in the manifests', async () => {
    await writeFile(path.join(repoRoot, 'sfdx-project.json'), JSON.stringify({ sourceApiVersion: '62.0' }), 'utf8');
    await commitBaseline({ 'classes/MyClass.cls': 'public class MyClass {}\n' });
    await writeRepoFiles(repoRoot, { 'classes/MyClass.cls': 'public class MyClass { }\n' });

    const result = await runDelta();

    expect(await readFile(result.packageManifestPath, 'utf8')).to.contain('<version>62.0</version>');
  });

  it('turns a rename into a destructive entry plus a package entry', async () => {
    await commitBaseline({
      'classes/OldName.cls': 'public class OldName { /* long enough body to be detected as a rename */ }\n',
      'classes/OldName.cls-meta.xml': `${XML_HEADER}<ApexClass ${NS}><apiVersion>61.0</apiVersion><status>Active</status></ApexClass>\n`,
    });
    runGit(repoRoot, ['mv', `${SOURCE_DIR}/classes/OldName.cls`, `${SOURCE_DIR}/classes/NewName.cls`]);
    runGit(repoRoot, ['mv', `${SOURCE_DIR}/classes/OldName.cls-meta.xml`, `${SOURCE_DIR}/classes/NewName.cls-meta.xml`]);

    const result = await runDelta();
    const destructiveManifest = await readFile(result.destructiveManifestPath!, 'utf8');

    expect(await packageHas('classes/NewName.cls')).to.equal(true);
    expect(await readFile(result.packageManifestPath, 'utf8')).to.contain('<members>NewName</members>');
    expect(destructiveManifest).to.contain('<members>OldName</members>');
  });

  const lwcBundle = {
    'lwc/myCmp/myCmp.js': 'export default class MyCmp {}\n',
    'lwc/myCmp/myCmp.html': '<template></template>\n',
    'lwc/myCmp/myCmp.css': '.title { color: red; }\n',
    'lwc/myCmp/myCmp.js-meta.xml': `${XML_HEADER}<LightningComponentBundle ${NS}><apiVersion>61.0</apiVersion></LightningComponentBundle>\n`,
  };

  it('redeploys an LWC bundle when only one of its files is deleted', async () => {
    await commitBaseline(lwcBundle);
    await rm(path.join(repoRoot, SOURCE_DIR, 'lwc/myCmp/myCmp.css'));

    const result = await runDelta();

    expect(await packageHas('lwc/myCmp/myCmp.js')).to.equal(true);
    expect(await packageHas('lwc/myCmp/myCmp.css')).to.equal(false);
    expect(await readFile(result.packageManifestPath, 'utf8')).to.contain('<members>myCmp</members>');
    expect(await exists(result.destructiveManifestPath!)).to.equal(false);
  });

  it('deletes an LWC bundle when the whole bundle is removed', async () => {
    await commitBaseline(lwcBundle);
    await rm(path.join(repoRoot, SOURCE_DIR, 'lwc/myCmp'), { recursive: true });

    const result = await runDelta();

    expect(await readFile(result.destructiveManifestPath!, 'utf8')).to.contain('<members>myCmp</members>');
    expect(await readFile(result.packageManifestPath, 'utf8')).not.to.contain('<members>myCmp</members>');
  });

  it('redeploys a folder static resource when one of its files is deleted', async () => {
    await commitBaseline({
      'staticresources/assets.resource-meta.xml': `${XML_HEADER}<StaticResource ${NS}><cacheControl>Private</cacheControl><contentType>application/zip</contentType></StaticResource>\n`,
      'staticresources/assets/css/app.css': 'body { color: red; }\n',
      'staticresources/assets/js/app.js': 'console.log(1);\n',
    });
    await rm(path.join(repoRoot, SOURCE_DIR, 'staticresources/assets/css/app.css'));

    const result = await runDelta();

    expect(await packageHas('staticresources/assets/js/app.js')).to.equal(true);
    expect(await readFile(result.packageManifestPath, 'utf8')).to.contain('<members>assets</members>');
    expect(await exists(result.destructiveManifestPath!)).to.equal(false);
  });

  it('handles a from ref where the source directory does not exist yet', async () => {
    await writeFile(path.join(repoRoot, 'README.md'), 'empty project\n', 'utf8');
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'base']);
    await writeRepoFiles(repoRoot, { 'classes/MyClass.cls': 'public class MyClass {}\n' });
    runGit(repoRoot, ['add', '.']);

    const result = await runDelta();

    expect(await packageHas('classes/MyClass.cls')).to.equal(true);
    expect(await readFile(result.packageManifestPath, 'utf8')).to.contain('<members>MyClass</members>');
  });
});
