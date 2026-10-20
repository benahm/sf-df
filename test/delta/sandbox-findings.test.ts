import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { formatMetadataFile, parseReadMetadataResponse } from '../../src/retrieve/metadata-read.js';
import { findProfileSources } from '../../src/retrieve/profile-retrieve.js';
import { useDeltaRepo } from './helpers/delta-repo.js';

// Behaviours found by deploying real deltas to a sandbox (see docs/git-delta-metadata-strategies.md).
// Each test names the Salesforce error or data loss it prevents.

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const objectXml = `${XML_HEADER}<CustomObject ${NS}><label>Invoice</label><pluralLabel>Invoices</pluralLabel><nameField><label>Name</label><type>Text</type></nameField><deploymentStatus>Deployed</deploymentStatus><sharingModel>ReadWrite</sharingModel></CustomObject>\n`;
const recordTypeXml = (name: string): string =>
  `${XML_HEADER}<RecordType ${NS}>\n    <fullName>${name}</fullName>\n    <active>true</active>\n    <label>${name}</label>\n</RecordType>\n`;
const fieldTranslationXml = (name: string, label: string): string =>
  `${XML_HEADER}<CustomFieldTranslation ${NS}><label>${label}</label><name>${name}</name></CustomFieldTranslation>\n`;

// The manifest entries as one text, for checks on what a manifest mentions anywhere.
const manifestText = (entries: string[]): string => entries.join('\n');
// The manifest entries of one metadata type ("Type:fullName").
const ofType = (entries: string[], type: string): string[] => entries.filter((entry) => entry.startsWith(`${type}:`));

describe('sandbox findings', () => {
  const ctx = useDeltaRepo();

  describe('deletions the Metadata API refuses', () => {
    it('deploys a deleted record type as inactive instead of "Cannot delete record type through API"', async () => {
      await ctx.repo.baseline({
        'objects/Invoice__c/Invoice__c.object-meta.xml': objectXml,
        'objects/Invoice__c/recordTypes/B2B.recordType-meta.xml': recordTypeXml('B2B'),
        'objects/Invoice__c/recordTypes/B2C.recordType-meta.xml': recordTypeXml('B2C'),
      });
      await ctx.repo.remove('objects/Invoice__c/recordTypes/B2C.recordType-meta.xml');

      const delta = await ctx.repo.delta();

      expect(await delta.packageFile('objects/Invoice__c/recordTypes/B2C.recordType-meta.xml')).to.contain(
        '<active>false</active>'
      );
      expect(delta.package).to.include('RecordType:Invoice__c.B2C');
      expect(manifestText(delta.destructive)).not.to.contain('RecordType');
      expect(delta.warnings).to.contain('RecordType:Invoice__c.B2C cannot be deleted');
    });

    it('does not deactivate the record types of a deleted object ("last active record type")', async () => {
      await ctx.repo.baseline({
        'objects/Invoice__c/Invoice__c.object-meta.xml': objectXml,
        'objects/Invoice__c/recordTypes/B2B.recordType-meta.xml': recordTypeXml('B2B'),
      });
      await ctx.repo.remove('objects/Invoice__c');

      const delta = await ctx.repo.delta();

      expect(manifestText(delta.package)).not.to.contain('RecordType');
      expect(delta.destructive).to.include('CustomObject:Invoice__c');
      expect(manifestText(delta.destructive)).not.to.contain('Invoice__c.B2B');
    });

    it('deactivates a deleted flow through its FlowDefinition instead of deleting it by name', async () => {
      await ctx.repo.baseline({
        'flows/My_Flow.flow-meta.xml': `${XML_HEADER}<Flow ${NS}><label>My Flow</label><processType>AutoLaunchedFlow</processType><status>Active</status></Flow>\n`,
      });
      await ctx.repo.remove('flows/My_Flow.flow-meta.xml');

      const delta = await ctx.repo.delta();

      expect(await delta.packageFile('flowDefinitions/My_Flow.flowDefinition-meta.xml')).to.contain(
        '<activeVersionNumber>0</activeVersionNumber>'
      );
      expect(delta.package).to.include('FlowDefinition:My_Flow');
      expect(ofType(delta.destructive, 'Flow')).to.deep.equal([]);
      expect(delta.warnings).to.contain('Flow:My_Flow cannot be deleted by name');
    });

    it('never lists a deleted standard value set ("is standard and cannot be deleted")', async () => {
      await ctx.repo.baseline({
        'standardValueSets/LeadSource.standardValueSet-meta.xml': `${XML_HEADER}<StandardValueSet ${NS}><sorted>false</sorted><standardValue><fullName>Web</fullName><default>false</default><label>Web</label></standardValue></StandardValueSet>\n`,
      });
      await ctx.repo.remove('standardValueSets/LeadSource.standardValueSet-meta.xml');

      const delta = await ctx.repo.delta();

      expect(manifestText(delta.destructive)).not.to.contain('StandardValueSet');
      expect(delta.warnings).to.contain('StandardValueSet:LeadSource cannot be deleted');
    });
  });

  describe('deletions that would remove far more than what was deleted', () => {
    it('never lists a whole language in destructiveChanges.xml when a Translations file is deleted', async () => {
      await ctx.repo.baseline({
        'translations/fr.translation-meta.xml': `${XML_HEADER}<Translations ${NS}><customLabels><label>Un</label><name>One</name></customLabels></Translations>\n`,
      });
      await ctx.repo.remove('translations/fr.translation-meta.xml');

      const delta = await ctx.repo.delta();

      expect(manifestText(delta.destructive)).not.to.contain('Translations');
      expect(delta.warnings).to.contain('Translations:fr is never deleted');
    });

    it('keeps the object translation when only one field translation file is deleted', async () => {
      await ctx.repo.baseline({
        'objectTranslations/Invoice__c-fr/Invoice__c-fr.objectTranslation-meta.xml': `${XML_HEADER}<CustomObjectTranslation ${NS}><caseValues><plural>false</plural><value>Facture</value></caseValues></CustomObjectTranslation>\n`,
        'objectTranslations/Invoice__c-fr/Amount__c.fieldTranslation-meta.xml': fieldTranslationXml('Amount__c', 'Montant'),
        'objectTranslations/Invoice__c-fr/Total__c.fieldTranslation-meta.xml': fieldTranslationXml('Total__c', 'Total'),
      });
      await ctx.repo.remove('objectTranslations/Invoice__c-fr/Total__c.fieldTranslation-meta.xml');

      const delta = await ctx.repo.delta();

      expect(manifestText(delta.destructive)).not.to.contain('CustomObjectTranslation');
      // Minimal delta: the remaining field translations are not redeployed.
      expect(delta.packageFiles).not.to.include('objectTranslations/Invoice__c-fr/Amount__c.fieldTranslation-meta.xml');
      expect(delta.warnings).to.contain('belongs to CustomObjectTranslation:Invoice__c-fr');
    });

    it('lists only the object (and its quick actions) when a custom object is deleted', async () => {
      await ctx.repo.baseline({
        'objects/Invoice__c/Invoice__c.object-meta.xml': objectXml,
        'objects/Invoice__c/fields/Amount__c.field-meta.xml': `${XML_HEADER}<CustomField ${NS}><fullName>Amount__c</fullName><label>Amount</label><type>Number</type><precision>18</precision><scale>2</scale></CustomField>\n`,
        'objects/Invoice__c/listViews/All.listView-meta.xml': `${XML_HEADER}<ListView ${NS}><fullName>All</fullName><filterScope>Everything</filterScope><label>All</label></ListView>\n`,
        'layouts/Invoice__c-Invoice Layout.layout-meta.xml': `${XML_HEADER}<Layout ${NS}></Layout>\n`,
        'quickActions/Invoice__c.Update.quickAction-meta.xml': `${XML_HEADER}<QuickAction ${NS}><label>Update</label><type>Update</type></QuickAction>\n`,
        'workflows/Invoice__c.workflow-meta.xml': `${XML_HEADER}<Workflow ${NS}><rules><fullName>WR1</fullName><active>false</active><formula>true</formula><triggerType>onCreateOnly</triggerType></rules></Workflow>\n`,
        'sharingRules/Invoice__c.sharingRules-meta.xml': `${XML_HEADER}<SharingRules ${NS}><sharingCriteriaRules><fullName>SR1</fullName><accessLevel>Read</accessLevel><label>SR1</label></sharingCriteriaRules></SharingRules>\n`,
      });
      await ctx.repo.remove(
        'objects/Invoice__c',
        'layouts',
        'quickActions',
        'workflows/Invoice__c.workflow-meta.xml',
        'sharingRules/Invoice__c.sharingRules-meta.xml'
      );

      const delta = await ctx.repo.delta();

      // Listing the workflow rules next to their object made the deployment fail with UNKNOWN_EXCEPTION.
      expect(ofType(delta.destructive, 'CustomObject')).not.to.deep.equal([]);
      expect(delta.destructive).to.include('QuickAction:Invoice__c.Update');
      for (const cascaded of ['CustomField', 'ListView', 'Layout', 'WorkflowRule', 'SharingCriteriaRule']) {
        expect(ofType(delta.destructive, cascaded)).to.deep.equal([]);
      }
    });
  });

  describe('bundles', () => {
    const lwrView = (name: string): Record<string, string> => ({
      [`digitalExperiences/site/Portal1/sfdc_cms__view/${name}/_meta.json`]: `{"apiName":"${name}","path":"","type":"sfdc_cms__view"}\n`,
      [`digitalExperiences/site/Portal1/sfdc_cms__view/${name}/content.json`]: `{"type":"sfdc_cms__view","title":"${name}"}\n`,
    });

    beforeEach(async () => {
      await ctx.repo.baseline({
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
      await ctx.repo.remove('digitalExperiences/site/Portal1/sfdc_cms__view/reporting');

      const delta = await ctx.repo.delta();

      expect(manifestText(delta.destructive)).to.contain('site/Portal1.sfdc_cms__view/reporting');
      expect(manifestText(delta.destructive)).not.to.contain('DigitalExperienceBundle');
      expect(manifestText(delta.destructive)).not.to.contain('sfdc_cms__view/home');
    });

    it('redeploys an LWR view when one of its files is deleted', async () => {
      await ctx.repo.remove('digitalExperiences/site/Portal1/sfdc_cms__view/home/content.json');

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal([]);
      expect(manifestText(delta.package)).to.contain('site/Portal1.sfdc_cms__view/home');
    });

    it('redeploys an Aura site without the deleted page instead of deleting the whole site', async () => {
      await ctx.repo.remove('experiences/Help1/routes/custom.json', 'experiences/Help1/views/custom.json');

      const delta = await ctx.repo.delta();

      expect(delta.destructive).to.deep.equal([]);
      expect(delta.package).to.include('ExperienceBundle:Help1');
      expect(delta.packageFiles).to.include('experiences/Help1/routes/home.json');
      expect(delta.packageFiles).not.to.include('experiences/Help1/routes/custom.json');
    });
  });

  describe('files that are not metadata', () => {
    it('reports a non-metadata file instead of aborting the whole delta', async () => {
      await ctx.repo.baseline({ 'classes/A.cls': 'public class A {}\n' });
      await ctx.repo.write({ '.gitkeep': '', 'classes/A.cls': 'public class A { }\n' });
      ctx.repo.commit();

      const delta = await ctx.repo.delta({ from: 'HEAD~1', to: 'HEAD' });

      expect(delta.package).to.include('ApexClass:A');
      expect(delta.warnings).to.contain('.gitkeep');
    });

    it('does not guess a bundle from the folder of a file SDR does not recognise', async () => {
      await ctx.repo.baseline({ 'classes/A.cls': 'public class A {}\n' });
      await ctx.repo.write({ 'lwc/jsconfig.json': '{}\n' });
      ctx.repo.commit();

      const delta = await ctx.repo.delta({ from: 'HEAD~1', to: 'HEAD' });

      expect(manifestText(delta.package)).not.to.contain('LightningComponentBundle');
    });

    it('skips files excluded by the .forceignore of the compared refs', async () => {
      await writeFile(path.join(ctx.repo.root, '.forceignore'), '**/jsconfig.json\n**/__tests__/**\n', 'utf8');
      await ctx.repo.baseline({ 'classes/A.cls': 'public class A {}\n' });
      await ctx.repo.write({
        'lwc/jsconfig.json': '{}\n',
        'lwc/cmp/__tests__/cmp.test.js': "describe('cmp', () => {});\n",
        'classes/A.cls': 'public class A { }\n',
      });
      ctx.repo.commit();

      const delta = await ctx.repo.delta({ from: 'HEAD~1', to: 'HEAD' });

      expect(delta.warnings).to.equal('');
      expect(delta.result.processedChanges).to.equal(1);
    });
  });

  describe('permission sets', () => {
    it('ships the whole permission set so removed accesses are revoked', async () => {
      const permissionSet = (classes: string[]): string =>
        `${XML_HEADER}<PermissionSet ${NS}>\n${classes
          .map((name) => `    <classAccesses>\n        <apexClass>${name}</apexClass>\n        <enabled>true</enabled>\n    </classAccesses>\n`)
          .join('')}    <label>PS</label>\n</PermissionSet>\n`;
      await ctx.repo.baseline({ 'permissionsets/PS.permissionset-meta.xml': permissionSet(['A', 'B', 'C']) });
      await ctx.repo.write({ 'permissionsets/PS.permissionset-meta.xml': permissionSet(['A', 'C']) });

      const delta = await ctx.repo.delta();

      // Verified on a sandbox: deploying a permission set replaces it, so a partial file would revoke A and C.
      const deployed = await delta.packageFile('permissionsets/PS.permissionset-meta.xml');
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
