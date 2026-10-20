import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { generateDelta } from '../../src/delta/engine.js';
import { diffCompositeXml, textOf } from '../../src/delta/xml.js';
import { useDeltaRepo } from './helpers/delta-repo.js';

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
  const ctx = useDeltaRepo();

  it('copies generic metadata files and writes package.xml', async () => {
    await ctx.repo.baseline({
      'classes/MyClass.cls':
        "public with sharing class MyClass {\n  public static String sayHi() {\n    return 'hi';\n  }\n}\n",
      'classes/MyClass.cls-meta.xml':
        '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>61.0</apiVersion><status>Active</status></ApexClass>\n',
    });
    await ctx.repo.write({
      'classes/MyClass.cls':
        "public with sharing class MyClass {\n  public static String sayHi() {\n    return 'hello';\n  }\n}\n",
    });

    const delta = await ctx.repo.delta();

    const copiedClass = await delta.packageFile('classes/MyClass.cls');
    const copiedMeta = await delta.packageFile('classes/MyClass.cls-meta.xml');
    const packageXml = await readFile(delta.result.packageManifestPath, 'utf8');

    expect(copiedClass).to.contain("return 'hello'");
    expect(copiedMeta).to.contain('<ApexClass');
    expect(packageXml).to.contain('<name>ApexClass</name>');
    expect(packageXml).to.contain('<members>MyClass</members>');
  });

  it('writes partial package and destructive XML for custom labels', async () => {
    await ctx.repo.baseline({
      'labels/CustomLabels.labels-meta.xml':
        '<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n  <labels><fullName>LabelOne</fullName><value>One</value></labels>\n  <labels><fullName>LabelTwo</fullName><value>Two</value></labels>\n</CustomLabels>\n',
    });
    await ctx.repo.write({
      'labels/CustomLabels.labels-meta.xml':
        '<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n  <labels><fullName>LabelTwo</fullName><value>Two updated</value></labels>\n  <labels><fullName>LabelThree</fullName><value>Three</value></labels>\n</CustomLabels>\n',
    });

    const delta = await ctx.repo.delta();

    const packageLabels = await delta.packageFile('labels/CustomLabels.labels-meta.xml');
    const destructiveLabels = await delta.destructiveFile('labels/CustomLabels.labels-meta.xml');
    const destructiveManifest = await readFile(delta.result.destructiveManifestPath!, 'utf8');

    expect(packageLabels).to.contain('LabelTwo');
    expect(packageLabels).to.contain('LabelThree');
    expect(packageLabels).not.to.contain('<fullName>LabelOne</fullName>');
    expect(destructiveLabels).to.contain('<fullName>LabelOne</fullName>');
    expect(destructiveManifest).to.contain('<name>CustomLabel</name>');
    expect(destructiveManifest).to.contain('<members>LabelOne</members>');
  });

  it('writes partial package XML for record types with required singleton fields', async () => {
    await ctx.repo.baseline({
      'objects/Invoice__c/recordTypes/B2B.recordType-meta.xml':
        '<?xml version="1.0" encoding="UTF-8"?>\n<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">\n  <fullName>B2B</fullName>\n  <active>true</active>\n  <label>B2B</label>\n  <businessProcess>InvoiceProcess</businessProcess>\n  <compactLayoutAssignment>Invoice_Compact</compactLayoutAssignment>\n  <picklistValues>\n    <picklist>Status__c</picklist>\n    <values><fullName>Draft</fullName><default>true</default></values>\n  </picklistValues>\n  <description>Baseline description</description>\n</RecordType>\n',
    });
    await ctx.repo.write({
      'objects/Invoice__c/recordTypes/B2B.recordType-meta.xml':
        '<?xml version="1.0" encoding="UTF-8"?>\n<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">\n  <fullName>B2B</fullName>\n  <active>true</active>\n  <label>B2B</label>\n  <businessProcess>InvoiceProcess</businessProcess>\n  <compactLayoutAssignment>Invoice_Compact</compactLayoutAssignment>\n  <picklistValues>\n    <picklist>Status__c</picklist>\n    <values><fullName>Draft</fullName><default>false</default></values>\n    <values><fullName>Approved</fullName><default>true</default></values>\n  </picklistValues>\n  <description>Baseline description</description>\n</RecordType>\n',
    });

    const delta = await ctx.repo.delta();

    const recordTypeDelta = await delta.packageFile('objects/Invoice__c/recordTypes/B2B.recordType-meta.xml');
    const packageXml = await readFile(delta.result.packageManifestPath, 'utf8');

    expect(recordTypeDelta).to.contain('<fullName>B2B</fullName>');
    expect(recordTypeDelta).to.contain('<active>true</active>');
    expect(recordTypeDelta).to.contain('<label>B2B</label>');
    expect(recordTypeDelta).to.contain('<businessProcess>InvoiceProcess</businessProcess>');
    expect(recordTypeDelta).to.contain('<compactLayoutAssignment>Invoice_Compact</compactLayoutAssignment>');
    expect(recordTypeDelta).to.contain('<picklistValues>');
    expect(recordTypeDelta).to.contain('<fullName>Approved</fullName>');
    expect(recordTypeDelta).not.to.contain('<description>Baseline description</description>');
    expect(packageXml).to.contain('<name>RecordType</name>');
    expect(packageXml).to.contain('<members>Invoice__c.B2B</members>');
  });

  it('keeps singleton-only RecordType updates in the delta output', async () => {
    await ctx.repo.baseline({
      'objects/Invoice__c/recordTypes/B2B.recordType-meta.xml':
        '<?xml version="1.0" encoding="UTF-8"?>\n<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">\n  <fullName>B2B</fullName>\n  <active>false</active>\n  <label>B2B Legacy</label>\n  <businessProcess>InvoiceProcess</businessProcess>\n  <compactLayoutAssignment>Invoice_Compact</compactLayoutAssignment>\n</RecordType>\n',
    });
    await ctx.repo.write({
      'objects/Invoice__c/recordTypes/B2B.recordType-meta.xml':
        '<?xml version="1.0" encoding="UTF-8"?>\n<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">\n  <fullName>B2B</fullName>\n  <active>true</active>\n  <label>B2B Updated</label>\n  <businessProcess>InvoiceProcess</businessProcess>\n  <compactLayoutAssignment>Invoice_Compact</compactLayoutAssignment>\n</RecordType>\n',
    });

    const delta = await ctx.repo.delta();

    const recordTypeDelta = await delta.packageFile('objects/Invoice__c/recordTypes/B2B.recordType-meta.xml');
    const packageXml = await readFile(delta.result.packageManifestPath, 'utf8');

    expect(recordTypeDelta).to.contain('<active>true</active>');
    expect(recordTypeDelta).to.contain('<label>B2B Updated</label>');
    expect(packageXml).to.contain('<name>RecordType</name>');
    expect(packageXml).to.contain('<members>Invoice__c.B2B</members>');
  });

  it('keeps record type strategy working when the metadata is newly added', async () => {
    await ctx.repo.baseline({
      'objects/Invoice__c/Invoice__c.object-meta.xml':
        '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Invoice</label><pluralLabel>Invoices</pluralLabel><nameField><label>Invoice Name</label><type>Text</type></nameField><deploymentStatus>Deployed</deploymentStatus><sharingModel>ReadWrite</sharingModel></CustomObject>\n',
    });
    await ctx.repo.write({
      'objects/Invoice__c/recordTypes/B2B.recordType-meta.xml':
        '<?xml version="1.0" encoding="UTF-8"?>\n<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">\n  <fullName>B2B</fullName>\n  <active>true</active>\n  <label>B2B</label>\n  <businessProcess>InvoiceProcess</businessProcess>\n  <compactLayoutAssignment>Invoice_Compact</compactLayoutAssignment>\n  <picklistValues>\n    <picklist>Status__c</picklist>\n    <values><fullName>Draft</fullName><default>true</default></values>\n  </picklistValues>\n  <description>Fresh record type</description>\n</RecordType>\n',
    });
    ctx.repo.commit('add record type');

    const delta = await ctx.repo.delta({ from: 'HEAD~1', to: 'HEAD' });

    const recordTypeDelta = await delta.packageFile('objects/Invoice__c/recordTypes/B2B.recordType-meta.xml');
    const packageXml = await readFile(delta.result.packageManifestPath, 'utf8');

    expect(recordTypeDelta).to.contain('<fullName>B2B</fullName>');
    expect(recordTypeDelta).to.contain('<label>B2B</label>');
    expect(recordTypeDelta).to.contain('<description>Fresh record type</description>');
    expect(packageXml).to.contain('<name>RecordType</name>');
    expect(packageXml).to.contain('<members>Invoice__c.B2B</members>');
  });
});

// These two tests set a custom sourceDir, which the shared helper does not allow (it fixes force-app/main/default),
// and they call generateDelta directly: they keep their own real git repository.
describe('delta engine', () => {
  let repoRoot: string | undefined;

  afterEach(async () => {
    if (repoRoot) {
      await rm(repoRoot, { recursive: true, force: true });
      repoRoot = undefined;
    }
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
      deployDir: path.join(outputDir, 'package'),
      destructiveDir: path.join(outputDir, 'destructive'),
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

  it('applies record type strategy when using a custom sourceDir', async () => {
    repoRoot = await setupRepo();

    await writeRepoFile(
      repoRoot,
      'pkg/main/default/objects/Invoice__c/recordTypes/B2B.recordType-meta.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">\n  <fullName>B2B</fullName>\n  <active>true</active>\n  <label>B2B</label>\n  <businessProcess>InvoiceProcess</businessProcess>\n  <compactLayoutAssignment>Invoice_Compact</compactLayoutAssignment>\n  <picklistValues>\n    <picklist>Status__c</picklist>\n    <values><fullName>Draft</fullName><default>true</default></values>\n  </picklistValues>\n  <description>Baseline description</description>\n</RecordType>\n'
    );

    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'base']);

    await writeRepoFile(
      repoRoot,
      'pkg/main/default/objects/Invoice__c/recordTypes/B2B.recordType-meta.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">\n  <fullName>B2B</fullName>\n  <active>true</active>\n  <label>B2B</label>\n  <businessProcess>InvoiceProcess</businessProcess>\n  <compactLayoutAssignment>Invoice_Compact</compactLayoutAssignment>\n  <picklistValues>\n    <picklist>Status__c</picklist>\n    <values><fullName>Draft</fullName><default>false</default></values>\n    <values><fullName>Approved</fullName><default>true</default></values>\n  </picklistValues>\n  <description>Baseline description</description>\n</RecordType>\n'
    );

    const outputDir = path.join(repoRoot, 'tmp-output');
    const result = await generateDelta({
      repoRoot,
      from: 'HEAD',
      sourceDir: 'pkg/main/default',
      deployDir: path.join(outputDir, 'package'),
      destructiveDir: path.join(outputDir, 'destructive'),
    });

    const recordTypeDelta = await readFile(
      path.join(outputDir, 'package/pkg/main/default/objects/Invoice__c/recordTypes/B2B.recordType-meta.xml'),
      'utf8'
    );
    const packageXml = await readFile(result.packageManifestPath, 'utf8');

    expect(recordTypeDelta).to.contain('<fullName>B2B</fullName>');
    expect(recordTypeDelta).to.contain('<picklistValues>');
    expect(recordTypeDelta).to.contain('<fullName>Approved</fullName>');
    expect(recordTypeDelta).not.to.contain('<description>Baseline description</description>');
    expect(packageXml).to.contain('<name>RecordType</name>');
    expect(packageXml).to.contain('<members>Invoice__c.B2B</members>');
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
        fieldPermissions: { keySelector: (item) => textOf(item.field) },
      },
      ['custom', 'userLicense']
    );

    expect(diff.packageXml).to.contain('<custom>false</custom>');
    expect(diff.packageXml).to.contain('<userLicense>Salesforce</userLicense>');
    expect(diff.packageXml).to.contain('<editable>true</editable>');
  });
});
