import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { generateDelta } from '../../src/delta/engine.js';
import { componentScope, SnapshotManager } from '../../src/delta/snapshot.js';

const SOURCE_DIR = 'force-app/main/default';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const runGit = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

const listFiles = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'))
    .sort();

const classMeta = `${XML_HEADER}<ApexClass ${NS}><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n`;
const fieldXml = (label: string): string =>
  `${XML_HEADER}<CustomField ${NS}><fullName>Amount__c</fullName><label>${label}</label><type>Number</type><precision>18</precision><scale>2</scale></CustomField>\n`;

const BASELINE: Record<string, string> = {
  'classes/Foo.cls': 'public class Foo {\n  public static Integer one() { return 1; }\n}\n',
  'classes/Foo.cls-meta.xml': classMeta,
  'classes/FooBar.cls': 'public class FooBar {}\n',
  'classes/FooBar.cls-meta.xml': classMeta,
  'objects/Invoice__c/Invoice__c.object-meta.xml': `${XML_HEADER}<CustomObject ${NS}><label>Invoice</label><pluralLabel>Invoices</pluralLabel><nameField><label>Name</label><type>Text</type></nameField><deploymentStatus>Deployed</deploymentStatus><sharingModel>ReadWrite</sharingModel></CustomObject>\n`,
  'objects/Invoice__c/fields/Amount__c.field-meta.xml': fieldXml('Amount'),
  'objects/Invoice__c/recordTypes/Standard.recordType-meta.xml': `${XML_HEADER}<RecordType ${NS}>\n    <fullName>Standard</fullName>\n    <active>true</active>\n    <label>Standard</label>\n</RecordType>\n`,
  'lwc/invoiceCard/invoiceCard.js': "import { LightningElement } from 'lwc';\nexport default class InvoiceCard extends LightningElement {}\n",
  'lwc/invoiceCard/invoiceCard.html': '<template><p>Invoice</p></template>\n',
  'lwc/invoiceCard/invoiceCard.css': 'p { color: red; }\n',
  'lwc/invoiceCard/invoiceCard.js-meta.xml': `${XML_HEADER}<LightningComponentBundle ${NS}><apiVersion>62.0</apiVersion><isExposed>false</isExposed></LightningComponentBundle>\n`,
  'staticresources/lib/a.js': 'var a = 1;\n',
  'staticresources/lib.resource-meta.xml': `${XML_HEADER}<StaticResource ${NS}><cacheControl>Private</cacheControl><contentType>application/zip</contentType></StaticResource>\n`,
  'reports/Sales/Pipeline.report-meta.xml': `${XML_HEADER}<Report ${NS}><name>Pipeline</name><format>Tabular</format><reportType>Opportunity</reportType></Report>\n`,
  'reports/Sales.reportFolder-meta.xml': `${XML_HEADER}<ReportFolder ${NS}><name>Sales</name><accessType>Public</accessType></ReportFolder>\n`,
};

describe('component scope', () => {
  const scopeKey = (relativePath: string, sourceDir = SOURCE_DIR): string | undefined =>
    componentScope(sourceDir, `${sourceDir}/${relativePath}`)?.key;

  it('groups a file with its -meta.xml, and not with files that only start with the same name', () => {
    expect(scopeKey('classes/Foo.cls')).to.equal(`${SOURCE_DIR}/classes/Foo`);
    expect(scopeKey('classes/Foo.cls-meta.xml')).to.equal(`${SOURCE_DIR}/classes/Foo`);
    expect(scopeKey('classes/FooBar.cls')).to.equal(`${SOURCE_DIR}/classes/FooBar`);
  });

  it('takes the whole folder of decomposed objects, bundles and report folders', () => {
    expect(scopeKey('objects/Invoice__c/fields/Amount__c.field-meta.xml')).to.equal(`${SOURCE_DIR}/objects/Invoice__c`);
    expect(scopeKey('objects/Invoice__c/Invoice__c.object-meta.xml')).to.equal(`${SOURCE_DIR}/objects/Invoice__c`);
    expect(scopeKey('lwc/invoiceCard/__tests__/invoiceCard.test.js')).to.equal(`${SOURCE_DIR}/lwc/invoiceCard`);
    expect(scopeKey('staticresources/lib/a.js')).to.equal(scopeKey('staticresources/lib.resource-meta.xml'));
    expect(scopeKey('reports/Sales/Pipeline.report-meta.xml')).to.equal(scopeKey('reports/Sales.reportFolder-meta.xml'));
  });

  it('finds the type folder below a source folder that is not split by type', () => {
    expect(scopeKey('main/default/classes/Foo.cls', 'force-app')).to.equal('force-app/main/default/classes/Foo');
  });

  it('has no scope outside a type folder, so the whole source folder is extracted', () => {
    expect(scopeKey('README.md')).to.equal(undefined);
    expect(scopeKey('custom/Foo.cls')).to.equal(undefined);
    expect(componentScope(SOURCE_DIR, 'docs/classes/Foo.cls')).to.equal(undefined);
  });
});

describe('snapshot', () => {
  let repoRoot: string;

  const writeFiles = async (files: Record<string, string>): Promise<void> => {
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(repoRoot, SOURCE_DIR, relativePath);
      // eslint-disable-next-line no-await-in-loop
      await mkdir(path.dirname(absolutePath), { recursive: true });
      // eslint-disable-next-line no-await-in-loop
      await writeFile(absolutePath, content, 'utf8');
    }
  };

  const commit = (message: string): void => {
    runGit(repoRoot, ['add', '-A']);
    runGit(repoRoot, ['commit', '-q', '-m', message]);
  };

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-snapshot-'));
    runGit(repoRoot, ['init', '-q']);
    runGit(repoRoot, ['config', 'user.email', 'delta@example.com']);
    runGit(repoRoot, ['config', 'user.name', 'Delta Tests']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
    await writeFile(path.join(repoRoot, 'sfdx-project.json'), JSON.stringify({ sourceApiVersion: '62.0' }));
    await writeFiles(BASELINE);
    commit('baseline');
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('extracts only the components of the given files', async () => {
    const manager = new SnapshotManager(repoRoot, SOURCE_DIR);
    try {
      const snapshot = await manager.createFrom('HEAD', [
        `${SOURCE_DIR}/classes/Foo.cls`,
        `${SOURCE_DIR}/objects/Invoice__c/fields/Amount__c.field-meta.xml`,
        `${SOURCE_DIR}/lwc/invoiceCard/invoiceCard.css`,
      ]);

      expect(await listFiles(snapshot.sourceDirAbs)).to.deep.equal([
        'classes/Foo.cls',
        'classes/Foo.cls-meta.xml',
        'lwc/invoiceCard/invoiceCard.css',
        'lwc/invoiceCard/invoiceCard.html',
        'lwc/invoiceCard/invoiceCard.js',
        'lwc/invoiceCard/invoiceCard.js-meta.xml',
        'objects/Invoice__c/Invoice__c.object-meta.xml',
        'objects/Invoice__c/fields/Amount__c.field-meta.xml',
        'objects/Invoice__c/recordTypes/Standard.recordType-meta.xml',
      ]);
    } finally {
      await manager.cleanup();
    }
  });

  it('extracts the whole source folder when a file is outside any type folder', async () => {
    const manager = new SnapshotManager(repoRoot, SOURCE_DIR);
    try {
      const snapshot = await manager.createFrom('HEAD', [`${SOURCE_DIR}/classes/Foo.cls`, `${SOURCE_DIR}/notes.txt`]);
      expect(await listFiles(snapshot.sourceDirAbs)).to.deep.equal(Object.keys(BASELINE).sort());
    } finally {
      await manager.cleanup();
    }
  });

  it('deploys the class body when only its -meta.xml changed between two commits', async () => {
    await writeFiles({ 'classes/Foo.cls-meta.xml': classMeta.replace('62.0', '63.0') });
    commit('api version');

    const outputRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-snapshot-out-'));
    try {
      const result = await generateDelta({
        repoRoot,
        from: 'HEAD~1',
        to: 'HEAD',
        sourceDir: SOURCE_DIR,
        deployDir: path.join(outputRoot, 'deploy'),
        destructiveDir: path.join(outputRoot, 'destructive'),
      });

      expect(await listFiles(path.join(outputRoot, 'deploy'))).to.deep.equal([
        `${SOURCE_DIR}/classes/Foo.cls`,
        `${SOURCE_DIR}/classes/Foo.cls-meta.xml`,
        'package.xml',
      ]);
      expect(await readFile(path.join(outputRoot, 'deploy', SOURCE_DIR, 'classes/Foo.cls'), 'utf8')).to.equal(
        BASELINE['classes/Foo.cls']
      );
      expect(await readFile(result.packageManifestPath, 'utf8')).to.include('<members>Foo</members>');
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it('gives the same delta between two commits as against the working tree', async () => {
    // Every case below reads the component on the other side of the change: a field needs its object, a partial
    // bundle delete needs the bundle, a deleted record type needs its object, a rename needs both names.
    await writeFiles({
      'objects/Invoice__c/fields/Amount__c.field-meta.xml': fieldXml('Total'),
      'staticresources/lib/a.js': 'var a = 2;\n',
    });
    await rm(path.join(repoRoot, SOURCE_DIR, 'lwc/invoiceCard/invoiceCard.css'));
    await rm(path.join(repoRoot, SOURCE_DIR, 'objects/Invoice__c/recordTypes/Standard.recordType-meta.xml'));
    runGit(repoRoot, ['mv', `${SOURCE_DIR}/classes/Foo.cls`, `${SOURCE_DIR}/classes/Bar.cls`]);
    runGit(repoRoot, ['mv', `${SOURCE_DIR}/classes/Foo.cls-meta.xml`, `${SOURCE_DIR}/classes/Bar.cls-meta.xml`]);
    commit('change');

    const outputRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-snapshot-out-'));
    try {
      const run = async (name: string, to?: string): Promise<Awaited<ReturnType<typeof generateDelta>>> =>
        generateDelta({
          repoRoot,
          from: 'HEAD~1',
          to,
          sourceDir: SOURCE_DIR,
          deployDir: path.join(outputRoot, name, 'deploy'),
          destructiveDir: path.join(outputRoot, name, 'destructive'),
        });

      const betweenCommits = await run('commits', 'HEAD');
      const againstWorkspace = await run('workspace');

      expect(betweenCommits.warnings).to.deep.equal(againstWorkspace.warnings);
      expect(betweenCommits.countsByStrategy).to.deep.equal(againstWorkspace.countsByStrategy);

      const packageXml = await readFile(betweenCommits.packageManifestPath, 'utf8');
      for (const member of ['Bar', 'Invoice__c.Amount__c', 'invoiceCard', 'Invoice__c.Standard', 'lib']) {
        expect(packageXml).to.include(`<members>${member}</members>`);
      }

      const destructiveXml = await readFile(betweenCommits.destructiveManifestPath!, 'utf8');
      expect(destructiveXml).to.include('<members>Foo</members>');
      expect(destructiveXml).not.to.include('invoiceCard');
      expect(destructiveXml).not.to.include('Standard');

      const commitsDir = path.join(outputRoot, 'commits');
      const workspaceDir = path.join(outputRoot, 'workspace');
      const files = await listFiles(commitsDir);
      expect(files).to.deep.equal(await listFiles(workspaceDir));
      expect(files).to.include.members([
        `deploy/${SOURCE_DIR}/lwc/invoiceCard/invoiceCard.js`,
        `deploy/${SOURCE_DIR}/staticresources/lib/a.js`,
        `deploy/${SOURCE_DIR}/staticresources/lib.resource-meta.xml`,
      ]);
      expect(files).not.to.include(`deploy/${SOURCE_DIR}/lwc/invoiceCard/invoiceCard.css`);
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        expect(await readFile(path.join(commitsDir, file), 'utf8'), file).to.equal(
          // eslint-disable-next-line no-await-in-loop
          await readFile(path.join(workspaceDir, file), 'utf8')
        );
      }
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
