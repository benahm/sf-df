import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { generateDelta } from '../../src/delta/engine.js';
import type { DeltaResult } from '../../src/delta/types.js';
import { formatMetadataFile, parseReadMetadataResponse } from '../../src/retrieve/metadata-read.js';
import { findProfileSources } from '../../src/retrieve/profile-retrieve.js';

// Behaviours found by deploying real deltas to a sandbox (see docs/git-delta-metadata-strategies.md).
// Each test names the Salesforce error or data loss it prevents.

const SOURCE_DIR = 'force-app/main/default';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const runGit = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

const exists = async (absolutePath: string): Promise<boolean> =>
  stat(absolutePath).then(
    () => true,
    () => false
  );

const objectXml = `${XML_HEADER}<CustomObject ${NS}><label>Invoice</label><pluralLabel>Invoices</pluralLabel><nameField><label>Name</label><type>Text</type></nameField><deploymentStatus>Deployed</deploymentStatus><sharingModel>ReadWrite</sharingModel></CustomObject>\n`;
const recordTypeXml = (name: string): string =>
  `${XML_HEADER}<RecordType ${NS}>\n    <fullName>${name}</fullName>\n    <active>true</active>\n    <label>${name}</label>\n</RecordType>\n`;
const fieldTranslationXml = (name: string, label: string): string =>
  `${XML_HEADER}<CustomFieldTranslation ${NS}><label>${label}</label><name>${name}</name></CustomFieldTranslation>\n`;

describe('sandbox findings', () => {
  let repoRoot: string;
  let outputDir: string;

  const writeFiles = async (files: Record<string, string>): Promise<void> => {
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(repoRoot, SOURCE_DIR, relativePath);
      // eslint-disable-next-line no-await-in-loop
      await mkdir(path.dirname(absolutePath), { recursive: true });
      // eslint-disable-next-line no-await-in-loop
      await writeFile(absolutePath, content, 'utf8');
    }
  };

  const removeFiles = async (...relativePaths: string[]): Promise<void> => {
    await Promise.all(
      relativePaths.map((relativePath) =>
        rm(path.join(repoRoot, SOURCE_DIR, relativePath), { recursive: true, force: true })
      )
    );
  };

  const commit = (message: string): void => {
    runGit(repoRoot, ['add', '-A']);
    runGit(repoRoot, ['commit', '-q', '--allow-empty', '-m', message]);
  };

  const commitBaseline = async (files: Record<string, string>): Promise<void> => {
    await writeFiles(files);
    commit('base');
  };

  const runDelta = (options: { to?: string; from?: string } = {}): Promise<DeltaResult> =>
    generateDelta({ repoRoot, from: options.from ?? 'HEAD', to: options.to, sourceDir: SOURCE_DIR, deployDir: path.join(outputDir, 'package'), destructiveDir: path.join(outputDir, 'destructive') });

  const packageFile = (relativePath: string): string => path.join(outputDir, 'package', SOURCE_DIR, relativePath);
  const destructiveManifest = async (result: DeltaResult): Promise<string> =>
    (await exists(result.destructiveManifestPath!)) ? readFile(result.destructiveManifestPath!, 'utf8') : '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-sandbox-'));
    outputDir = path.join(repoRoot, 'tmp-output');
    runGit(repoRoot, ['init', '-q']);
    runGit(repoRoot, ['config', 'user.email', 'delta@example.com']);
    runGit(repoRoot, ['config', 'user.name', 'Delta Tests']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
    await writeFile(path.join(repoRoot, '.gitignore'), 'tmp-output/\n', 'utf8');
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  describe('deletions the Metadata API refuses', () => {
    it('deploys a deleted record type as inactive instead of "Cannot delete record type through API"', async () => {
      await commitBaseline({
        'objects/Invoice__c/Invoice__c.object-meta.xml': objectXml,
        'objects/Invoice__c/recordTypes/B2B.recordType-meta.xml': recordTypeXml('B2B'),
        'objects/Invoice__c/recordTypes/B2C.recordType-meta.xml': recordTypeXml('B2C'),
      });
      await removeFiles('objects/Invoice__c/recordTypes/B2C.recordType-meta.xml');

      const result = await runDelta();

      expect(await readFile(packageFile('objects/Invoice__c/recordTypes/B2C.recordType-meta.xml'), 'utf8')).to.contain(
        '<active>false</active>'
      );
      expect(await readFile(result.packageManifestPath, 'utf8')).to.contain('<members>Invoice__c.B2C</members>');
      expect(await destructiveManifest(result)).not.to.contain('RecordType');
      expect(result.warnings.join('\n')).to.contain('RecordType:Invoice__c.B2C cannot be deleted');
    });

    it('does not deactivate the record types of a deleted object ("last active record type")', async () => {
      await commitBaseline({
        'objects/Invoice__c/Invoice__c.object-meta.xml': objectXml,
        'objects/Invoice__c/recordTypes/B2B.recordType-meta.xml': recordTypeXml('B2B'),
      });
      await removeFiles('objects/Invoice__c');

      const result = await runDelta();

      expect(await readFile(result.packageManifestPath, 'utf8')).not.to.contain('RecordType');
      expect(await destructiveManifest(result)).to.contain('<members>Invoice__c</members>');
      expect(await destructiveManifest(result)).not.to.contain('Invoice__c.B2B');
    });

    it('deactivates a deleted flow through its FlowDefinition instead of deleting it by name', async () => {
      await commitBaseline({
        'flows/My_Flow.flow-meta.xml': `${XML_HEADER}<Flow ${NS}><label>My Flow</label><processType>AutoLaunchedFlow</processType><status>Active</status></Flow>\n`,
      });
      await removeFiles('flows/My_Flow.flow-meta.xml');

      const result = await runDelta();

      expect(await readFile(packageFile('flowDefinitions/My_Flow.flowDefinition-meta.xml'), 'utf8')).to.contain(
        '<activeVersionNumber>0</activeVersionNumber>'
      );
      expect(await readFile(result.packageManifestPath, 'utf8')).to.contain('<name>FlowDefinition</name>');
      expect(await destructiveManifest(result)).not.to.contain('<name>Flow</name>');
      expect(result.warnings.join('\n')).to.contain('Flow:My_Flow cannot be deleted by name');
    });

    it('never lists a deleted standard value set ("is standard and cannot be deleted")', async () => {
      await commitBaseline({
        'standardValueSets/LeadSource.standardValueSet-meta.xml': `${XML_HEADER}<StandardValueSet ${NS}><sorted>false</sorted><standardValue><fullName>Web</fullName><default>false</default><label>Web</label></standardValue></StandardValueSet>\n`,
      });
      await removeFiles('standardValueSets/LeadSource.standardValueSet-meta.xml');

      const result = await runDelta();

      expect(await destructiveManifest(result)).not.to.contain('StandardValueSet');
      expect(result.warnings.join('\n')).to.contain('StandardValueSet:LeadSource cannot be deleted');
    });
  });

  describe('deletions that would remove far more than what was deleted', () => {
    it('never lists a whole language in destructiveChanges.xml when a Translations file is deleted', async () => {
      await commitBaseline({
        'translations/fr.translation-meta.xml': `${XML_HEADER}<Translations ${NS}><customLabels><label>Un</label><name>One</name></customLabels></Translations>\n`,
      });
      await removeFiles('translations/fr.translation-meta.xml');

      const result = await runDelta();

      expect(await destructiveManifest(result)).not.to.contain('Translations');
      expect(result.warnings.join('\n')).to.contain('Translations:fr is never deleted');
    });

    it('keeps the object translation when only one field translation file is deleted', async () => {
      await commitBaseline({
        'objectTranslations/Invoice__c-fr/Invoice__c-fr.objectTranslation-meta.xml': `${XML_HEADER}<CustomObjectTranslation ${NS}><caseValues><plural>false</plural><value>Facture</value></caseValues></CustomObjectTranslation>\n`,
        'objectTranslations/Invoice__c-fr/Amount__c.fieldTranslation-meta.xml': fieldTranslationXml('Amount__c', 'Montant'),
        'objectTranslations/Invoice__c-fr/Total__c.fieldTranslation-meta.xml': fieldTranslationXml('Total__c', 'Total'),
      });
      await removeFiles('objectTranslations/Invoice__c-fr/Total__c.fieldTranslation-meta.xml');

      const result = await runDelta();

      expect(await destructiveManifest(result)).not.to.contain('CustomObjectTranslation');
      // Minimal delta: the remaining field translations are not redeployed.
      expect(await exists(packageFile('objectTranslations/Invoice__c-fr/Amount__c.fieldTranslation-meta.xml'))).to.equal(
        false
      );
      expect(result.warnings.join('\n')).to.contain('belongs to CustomObjectTranslation:Invoice__c-fr');
    });

    it('lists only the object (and its quick actions) when a custom object is deleted', async () => {
      await commitBaseline({
        'objects/Invoice__c/Invoice__c.object-meta.xml': objectXml,
        'objects/Invoice__c/fields/Amount__c.field-meta.xml': `${XML_HEADER}<CustomField ${NS}><fullName>Amount__c</fullName><label>Amount</label><type>Number</type><precision>18</precision><scale>2</scale></CustomField>\n`,
        'objects/Invoice__c/listViews/All.listView-meta.xml': `${XML_HEADER}<ListView ${NS}><fullName>All</fullName><filterScope>Everything</filterScope><label>All</label></ListView>\n`,
        'layouts/Invoice__c-Invoice Layout.layout-meta.xml': `${XML_HEADER}<Layout ${NS}></Layout>\n`,
        'quickActions/Invoice__c.Update.quickAction-meta.xml': `${XML_HEADER}<QuickAction ${NS}><label>Update</label><type>Update</type></QuickAction>\n`,
        'workflows/Invoice__c.workflow-meta.xml': `${XML_HEADER}<Workflow ${NS}><rules><fullName>WR1</fullName><active>false</active><formula>true</formula><triggerType>onCreateOnly</triggerType></rules></Workflow>\n`,
        'sharingRules/Invoice__c.sharingRules-meta.xml': `${XML_HEADER}<SharingRules ${NS}><sharingCriteriaRules><fullName>SR1</fullName><accessLevel>Read</accessLevel><label>SR1</label></sharingCriteriaRules></SharingRules>\n`,
      });
      await removeFiles(
        'objects/Invoice__c',
        'layouts',
        'quickActions',
        'workflows/Invoice__c.workflow-meta.xml',
        'sharingRules/Invoice__c.sharingRules-meta.xml'
      );

      const result = await runDelta();
      const destructive = await destructiveManifest(result);

      // Listing the workflow rules next to their object made the deployment fail with UNKNOWN_EXCEPTION.
      expect(destructive).to.contain('<name>CustomObject</name>');
      expect(destructive).to.contain('<members>Invoice__c.Update</members>');
      for (const cascaded of ['CustomField', 'ListView', 'Layout', 'WorkflowRule', 'SharingCriteriaRule']) {
        expect(destructive).not.to.contain(`<name>${cascaded}</name>`);
      }
    });
  });

  describe('bundles', () => {
    const lwrView = (name: string): Record<string, string> => ({
      [`digitalExperiences/site/Portal1/sfdc_cms__view/${name}/_meta.json`]: `{"apiName":"${name}","path":"","type":"sfdc_cms__view"}\n`,
      [`digitalExperiences/site/Portal1/sfdc_cms__view/${name}/content.json`]: `{"type":"sfdc_cms__view","title":"${name}"}\n`,
    });

    beforeEach(async () => {
      await commitBaseline({
        'digitalExperiences/site/Portal1/Portal1.digitalExperience-meta.xml': `${XML_HEADER}<DigitalExperienceBundle ${NS}><label>Portal1</label></DigitalExperienceBundle>\n`,
        ...lwrView('home'),
        ...lwrView('reporting'),
        'experiences/Help1.site-meta.xml': `${XML_HEADER}<ExperienceBundle ${NS}><label>Help1</label><type>customer</type></ExperienceBundle>\n`,
        'experiences/Help1/routes/home.json': '{"routeType":"home"}\n',
        'experiences/Help1/routes/custom.json': '{"routeType":"custom-page"}\n',
        'experiences/Help1/views/custom.json': '{"viewType":"custom-page"}\n',
      });
    });

    it('deletes only the removed page of an LWR site', async () => {
      await removeFiles('digitalExperiences/site/Portal1/sfdc_cms__view/reporting');

      const result = await runDelta();
      const destructive = await destructiveManifest(result);

      expect(destructive).to.contain('<members>site/Portal1.sfdc_cms__view/reporting</members>');
      expect(destructive).not.to.contain('DigitalExperienceBundle');
      expect(destructive).not.to.contain('sfdc_cms__view/home');
    });

    it('redeploys an LWR view when one of its files is deleted', async () => {
      await removeFiles('digitalExperiences/site/Portal1/sfdc_cms__view/home/content.json');

      const result = await runDelta();

      expect(await destructiveManifest(result)).to.equal('');
      expect(await readFile(result.packageManifestPath, 'utf8')).to.contain(
        '<members>site/Portal1.sfdc_cms__view/home</members>'
      );
    });

    it('redeploys an Aura site without the deleted page instead of deleting the whole site', async () => {
      await removeFiles('experiences/Help1/routes/custom.json', 'experiences/Help1/views/custom.json');

      const result = await runDelta();

      expect(await destructiveManifest(result)).to.equal('');
      expect(await readFile(result.packageManifestPath, 'utf8')).to.contain('<members>Help1</members>');
      expect(await exists(packageFile('experiences/Help1/routes/home.json'))).to.equal(true);
      expect(await exists(packageFile('experiences/Help1/routes/custom.json'))).to.equal(false);
    });
  });

  describe('files that are not metadata', () => {
    it('reports a non-metadata file instead of aborting the whole delta', async () => {
      await commitBaseline({ 'classes/A.cls': 'public class A {}\n' });
      await writeFiles({ '.gitkeep': '', 'classes/A.cls': 'public class A { }\n' });
      commit('change');

      const result = await runDelta({ from: 'HEAD~1', to: 'HEAD' });

      expect(await readFile(result.packageManifestPath, 'utf8')).to.contain('<members>A</members>');
      expect(result.warnings.join('\n')).to.contain('.gitkeep');
    });

    it('does not guess a bundle from the folder of a file SDR does not recognise', async () => {
      await commitBaseline({ 'classes/A.cls': 'public class A {}\n' });
      await writeFiles({ 'lwc/jsconfig.json': '{}\n' });
      commit('change');

      const result = await runDelta({ from: 'HEAD~1', to: 'HEAD' });

      expect(await readFile(result.packageManifestPath, 'utf8')).not.to.contain('LightningComponentBundle');
    });

    it('skips files excluded by the .forceignore of the compared refs', async () => {
      await writeFile(path.join(repoRoot, '.forceignore'), '**/jsconfig.json\n**/__tests__/**\n', 'utf8');
      await commitBaseline({ 'classes/A.cls': 'public class A {}\n' });
      await writeFiles({
        'lwc/jsconfig.json': '{}\n',
        'lwc/cmp/__tests__/cmp.test.js': "describe('cmp', () => {});\n",
        'classes/A.cls': 'public class A { }\n',
      });
      commit('change');

      const result = await runDelta({ from: 'HEAD~1', to: 'HEAD' });

      expect(result.warnings).to.deep.equal([]);
      expect(result.processedChanges).to.equal(1);
    });
  });

  describe('permission sets', () => {
    it('ships the whole permission set so removed accesses are revoked', async () => {
      const permissionSet = (classes: string[]): string =>
        `${XML_HEADER}<PermissionSet ${NS}>\n${classes
          .map((name) => `    <classAccesses>\n        <apexClass>${name}</apexClass>\n        <enabled>true</enabled>\n    </classAccesses>\n`)
          .join('')}    <label>PS</label>\n</PermissionSet>\n`;
      await commitBaseline({ 'permissionsets/PS.permissionset-meta.xml': permissionSet(['A', 'B', 'C']) });
      await writeFiles({ 'permissionsets/PS.permissionset-meta.xml': permissionSet(['A', 'C']) });

      await runDelta();

      // Verified on a sandbox: deploying a permission set replaces it, so a partial file would revoke A and C.
      const deployed = await readFile(packageFile('permissionsets/PS.permissionset-meta.xml'), 'utf8');
      expect(deployed).to.contain('<apexClass>A</apexClass>');
      expect(deployed).to.contain('<apexClass>C</apexClass>');
    });
  });
});

// Found while building `sf df profile retrieve` on a 600-profile sandbox (API 64.0).
describe('sandbox findings: profile retrieve', () => {
  it('readMetadata answers xsi:nil for an unknown profile: it is not an empty profile to write', () => {
    const response =
      '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body><readMetadataResponse><result><records xsi:nil="true"/></result></readMetadataResponse></soapenv:Body></soapenv:Envelope>';

    expect(parseReadMetadataResponse(response)).to.deep.equal([undefined]);
  });

  it('the API full name of a profile is its encoded file name ("System Admin %2B Bulk Delete Permission")', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-df-profile-name-'));
    try {
      const filePath = path.join(root, 'System Admin %2B Bulk Delete Permission.profile-meta.xml');
      await writeFile(filePath, `${XML_HEADER}<Profile ${NS}/>\n`, 'utf8');

      expect(findProfileSources(root).map((source) => source.fullName)).to.deep.equal(['System Admin %2B Bulk Delete Permission']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('the readMetadata record re-indented is byte for byte what sf project retrieve writes', () => {
    // Excerpt of the Admin profile: readMetadata response body, then the file retrieved by sf project retrieve.
    const body =
      '<applicationVisibilities><application>SalesConsole</application><default>false</default><visible>true</visible></applicationVisibilities>' +
      '<custom>false</custom><userLicense>Salesforce</userLicense>';
    const retrieved = `${XML_HEADER}<Profile ${NS}>
    <applicationVisibilities>
        <application>SalesConsole</application>
        <default>false</default>
        <visible>true</visible>
    </applicationVisibilities>
    <custom>false</custom>
    <userLicense>Salesforce</userLicense>
</Profile>
`;

    expect(formatMetadataFile('Profile', body)).to.equal(retrieved);
  });
});
