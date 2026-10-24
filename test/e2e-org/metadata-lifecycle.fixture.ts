import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Builds a git repo whose commits walk the most common metadata types through their whole lifecycle:
// p1 adds everything, p2 modifies / partially deletes / renames, p2b revokes permission set accesses,
// p3 deletes everything. Components on standard objects (a business process on Opportunity, a value added to the
// LeadSource standard value set) are only built for a disposable org, see StandardObjects. Every component is prefixed with SfDfQa and the objects carry a per-run suffix,
// because Salesforce keeps deleted objects in its recycle bin and refuses to recreate the same name.

export const SOURCE_DIR = 'force-app/main/default';
const API = '64.0';
const H = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

export type LifecycleNames = { obj: string; setting: string; flow: string; flow2: string; valueSet: string };

// Built only on a scratch org: they change standard objects, and the API cannot delete a standard value set.
export type StandardObjects = { leadSourceXml: string };

export const lifecycleNames = (suffix: string): LifecycleNames => ({
  obj: `SfDfQa_Obj${suffix}__c`,
  setting: `SfDfQa_Set${suffix}`,
  flow: `SfDfQa_Flow${suffix}`,
  flow2: `SfDfQa_FlowB${suffix}`,
  valueSet: `SfDfQa_GVS${suffix}`,
});

export const createLifecycleRepo = (repo: string, names: LifecycleNames, language = 'fr', standard?: StandardObjects) => {
  const { obj, setting } = names;
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const write = (rel: string, content: string): void => {
    const abs = path.join(repo, SOURCE_DIR, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const remove = (rel: string): void => rmSync(path.join(repo, SOURCE_DIR, rel), { recursive: true, force: true });
  const xml = (root: string, body: string, extraNs = ''): string => `${H}<${root} ${NS}${extraNs}>\n${body}\n</${root}>\n`;
  const commit = (message: string): void => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };

  const apexClass = (name: string, body: string): void => {
    write(`classes/${name}.cls`, `public with sharing class ${name} {\n    ${body}\n}\n`);
    write(`classes/${name}.cls-meta.xml`, xml('ApexClass', `<apiVersion>${API}</apiVersion><status>Active</status>`));
  };
  const trigger = (body: string): void => {
    write('triggers/SfDfQaObjTrigger.trigger', `trigger SfDfQaObjTrigger on ${obj} (before insert) {\n    ${body}\n}\n`);
    write('triggers/SfDfQaObjTrigger.trigger-meta.xml', xml('ApexTrigger', `<apiVersion>${API}</apiVersion><status>Active</status>`));
  };
  const vfPage = (name: string, text: string): void => {
    write(`pages/${name}.page`, `<apex:page>${text}</apex:page>\n`);
    write(`pages/${name}.page-meta.xml`, xml('ApexPage', `<apiVersion>${API}</apiVersion><label>${name}</label>`));
  };
  const vfComponent = (text: string): void => {
    write('components/SfDfQaComp.component', `<apex:component>${text}</apex:component>\n`);
    write('components/SfDfQaComp.component-meta.xml', xml('ApexComponent', `<apiVersion>${API}</apiVersion><label>SfDfQaComp</label>`));
  };
  const lwc = (name: string, cls: string, html: string, css: string | undefined, exposed: boolean): void => {
    write(`lwc/${name}/${name}.js`, `import { LightningElement } from 'lwc';\n\nexport default class ${cls} extends LightningElement {}\n`);
    write(`lwc/${name}/${name}.html`, `<template>${html}</template>\n`);
    if (css) {
      write(`lwc/${name}/${name}.css`, css);
    }
    write(
      `lwc/${name}/${name}.js-meta.xml`,
      xml(
        'LightningComponentBundle',
        `<apiVersion>${API}</apiVersion><isExposed>${exposed}</isExposed>${exposed ? '<targets><target>lightning__AppPage</target></targets>' : ''}`
      )
    );
  };
  const label = (name: string, value: string): string =>
    `<labels><fullName>${name}</fullName><categories>qa</categories><language>en_US</language><protected>false</protected><shortDescription>${name}</shortDescription><value>${value}</value></labels>`;
  const textField = (name: string, lbl: string): void =>
    write(
      `objects/${obj}/fields/${name}.field-meta.xml`,
      xml('CustomField', `<fullName>${name}</fullName><label>${lbl}</label><length>50</length><required>false</required><type>Text</type><unique>false</unique>`)
    );
  const statusField = (values: string[]): void =>
    write(
      `objects/${obj}/fields/Status__c.field-meta.xml`,
      xml(
        'CustomField',
        `<fullName>Status__c</fullName><label>Status</label><required>false</required><type>Picklist</type><valueSet><restricted>true</restricted><valueSetDefinition><sorted>false</sorted>${values
          .map((v) => `<value><fullName>${v}</fullName><default>false</default><label>${v}</label></value>`)
          .join('')}</valueSetDefinition></valueSet>`
      )
    );
  const recordType = (name: string, lbl: string, values: string[]): void =>
    write(
      `objects/${obj}/recordTypes/${name}.recordType-meta.xml`,
      xml(
        'RecordType',
        `<fullName>${name}</fullName><active>true</active><label>${lbl}</label><picklistValues><picklist>Status__c</picklist>${values
          .map((v) => `<values><fullName>${v}</fullName><default>false</default></values>`)
          .join('')}</picklistValues>`
      )
    );
  const listView = (name: string, scope: string): void =>
    write(
      `objects/${obj}/listViews/${name}.listView-meta.xml`,
      xml('ListView', `<fullName>${name}</fullName><columns>NAME</columns><filterScope>${scope}</filterScope><label>${name}</label>`)
    );
  const validationRule = (name: string, message: string): void =>
    write(
      `objects/${obj}/validationRules/${name}.validationRule-meta.xml`,
      xml(
        'ValidationRule',
        `<fullName>${name}</fullName><active>true</active><errorConditionFormula>LEN(F1__c) &gt; 45</errorConditionFormula><errorMessage>${message}</errorMessage>`
      )
    );
  const webLink = (version: string): void =>
    write(
      `objects/${obj}/webLinks/Link1.webLink-meta.xml`,
      xml(
        'WebLink',
        `<fullName>Link1</fullName><availability>online</availability><displayType>button</displayType><encodingKey>UTF-8</encodingKey><linkType>url</linkType><masterLabel>Link1 ${version}</masterLabel><openType>replace</openType><protected>false</protected><url>https://example.com/${version}</url>`
      )
    );
  const compactLayout = (fields: string[], version: string): void =>
    write(
      `objects/${obj}/compactLayouts/CL1.compactLayout-meta.xml`,
      xml('CompactLayout', `<fullName>CL1</fullName>${fields.map((f) => `<fields>${f}</fields>`).join('')}<label>CL1 ${version}</label>`)
    );
  const fieldSet = (version: string): void =>
    write(
      `objects/${obj}/fieldSets/FS1.fieldSet-meta.xml`,
      xml(
        'FieldSet',
        `<fullName>FS1</fullName><description>${version}</description><displayedFields><field>F1__c</field><isFieldManaged>false</isFieldManaged><isRequired>false</isRequired></displayedFields><label>FS1</label>`
      )
    );
  const layout = (fields: string[]): void =>
    write(
      `layouts/${obj}-SfDfQa Layout.layout-meta.xml`,
      xml(
        'Layout',
        `<layoutSections><customLabel>false</customLabel><detailHeading>false</detailHeading><editHeading>true</editHeading><label>Information</label><layoutColumns><layoutItems><behavior>Required</behavior><field>Name</field></layoutItems>${fields
          .map((f) => `<layoutItems><behavior>Edit</behavior><field>${f}</field></layoutItems>`)
          .join('')}</layoutColumns><style>OneColumn</style></layoutSections>`
      )
    );
  const cmdtRecord = (name: string, value: string): void =>
    write(
      `customMetadata/${setting}.${name}.md-meta.xml`,
      xml(
        'CustomMetadata',
        `<label>${name}</label><protected>false</protected><values><field>Value__c</field><value xsi:type="xsd:string">${value}</value></values>`,
        ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
      )
    );
  const flow = (name: string, lbl: string): void =>
    write(
      `flows/${name}.flow-meta.xml`,
      xml(
        'Flow',
        `<apiVersion>${API}</apiVersion><assignments><name>Set_V</name><label>Set V</label><locationX>176</locationX><locationY>134</locationY><assignmentItems><assignToReference>v1</assignToReference><operator>Assign</operator><value><stringValue>x</stringValue></value></assignmentItems></assignments><environments>Default</environments><interviewLabel>${lbl} {!$Flow.CurrentDateTime}</interviewLabel><label>${lbl}</label><processMetadataValues><name>BuilderType</name><value><stringValue>LightningFlowBuilder</stringValue></value></processMetadataValues><processType>AutoLaunchedFlow</processType><start><locationX>50</locationX><locationY>0</locationY><connector><targetReference>Set_V</targetReference></connector></start><status>Draft</status><variables><name>v1</name><dataType>String</dataType><isCollection>false</isCollection><isInput>false</isInput><isOutput>false</isOutput></variables>`
      )
    );
  const permissionSet = (classes: string[], fields: Array<[string, boolean]>, perms: string[]): void =>
    write(
      'permissionsets/SfDfQa_PS.permissionset-meta.xml',
      xml(
        'PermissionSet',
        [
          ...classes.map((c) => `<classAccesses><apexClass>${c}</apexClass><enabled>true</enabled></classAccesses>`),
          ...perms.map((p) => `<customPermissions><enabled>true</enabled><name>${p}</name></customPermissions>`),
          ...fields.map(
            ([f, editable]) =>
              `<fieldPermissions><editable>${editable}</editable><field>${obj}.${f}</field><readable>true</readable></fieldPermissions>`
          ),
          '<hasActivationRequired>false</hasActivationRequired><label>SfDfQa PS</label>',
          `<objectPermissions><allowCreate>true</allowCreate><allowDelete>false</allowDelete><allowEdit>true</allowEdit><allowRead>true</allowRead><modifyAllRecords>false</modifyAllRecords><object>${obj}</object><viewAllFields>false</viewAllFields><viewAllRecords>false</viewAllRecords></objectPermissions>`,
          `<tabSettings><tab>${obj}</tab><visibility>Visible</visibility></tabSettings>`,
        ].join('\n')
      )
    );
  const customPermission = (name: string): void =>
    write(`customPermissions/${name}.customPermission-meta.xml`, xml('CustomPermission', `<isLicensed>false</isLicensed><label>${name}</label>`));
  const quickAction = (lbl: string): void =>
    write(
      `quickActions/${obj}.SfDfQa_Update.quickAction-meta.xml`,
      xml(
        'QuickAction',
        `<label>${lbl}</label><optionsCreateFeedItem>false</optionsCreateFeedItem><quickActionLayout><layoutSectionStyle>TwoColumnsLeftToRight</layoutSectionStyle><quickActionLayoutColumns><quickActionLayoutItems><emptySpace>false</emptySpace><field>F1__c</field><uiBehavior>Edit</uiBehavior></quickActionLayoutItems></quickActionLayoutColumns><quickActionLayoutColumns/></quickActionLayout><type>Update</type>`
      )
    );
  const sharingRule = (name: string, access: string): string =>
    `<sharingCriteriaRules><fullName>${name}</fullName><accessLevel>${access}</accessLevel><label>${name}</label><sharedTo><group>SfDfQa_Group</group></sharedTo><criteriaItems><field>F1__c</field><operation>equals</operation><value>${name}</value></criteriaItems><includeRecordsOwnedByAll>true</includeRecordsOwnedByAll></sharingCriteriaRules>`;
  const fieldUpdate = (name: string, value: string): string =>
    `<fieldUpdates><fullName>${name}</fullName><field>F1__c</field><formula>&quot;${value}&quot;</formula><name>${name}</name><notifyAssignee>false</notifyAssignee><operation>Formula</operation><protected>false</protected></fieldUpdates>`;
  const workflowRule = (name: string, fu: string, formula: string): string =>
    `<rules><fullName>${name}</fullName><actions><name>${fu}</name><type>FieldUpdate</type></actions><active>false</active><formula>${formula}</formula><triggerType>onCreateOnly</triggerType></rules>`;
  const emailTemplate = (name: string, body: string): void => {
    write(`email/SfDfQa_Folder/${name}.email`, body);
    write(
      `email/SfDfQa_Folder/${name}.email-meta.xml`,
      xml('EmailTemplate', `<available>true</available><encodingKey>UTF-8</encodingKey><name>${name}</name><style>none</style><subject>${name}</subject><type>text</type><uiType>Aloha</uiType>`)
    );
  };
  const report = (lbl: string): void =>
    write(
      'reports/SfDfQa_Reports/SfDfQa_Report.report-meta.xml',
      xml(
        'Report',
        `<columns><field>CUST_NAME</field></columns><format>Tabular</format><name>${lbl}</name><params><name>co</name><value>1</value></params><reportType>CustomEntity$${obj}</reportType><scope>organization</scope><showDetails>true</showDetails><showGrandTotal>true</showGrandTotal><showSubTotals>true</showSubTotals><timeFrameFilter><dateColumn>CUST_CREATED_DATE</dateColumn><interval>INTERVAL_CUSTOM</interval></timeFrameFilter>`
      )
    );
  const flexiPage = (text: string): void =>
    write(
      'flexipages/SfDfQa_Page.flexipage-meta.xml',
      xml(
        'FlexiPage',
        `<flexiPageRegions><itemInstances><componentInstance><componentInstanceProperties><name>richTextValue</name><value>&lt;p&gt;${text}&lt;/p&gt;</value></componentInstanceProperties><componentName>flexipage:richText</componentName><identifier>flexipage_richText</identifier></componentInstance></itemInstances><name>main</name><type>Region</type></flexiPageRegions><masterLabel>SfDfQa Page</masterLabel><template><name>flexipage:defaultAppHomeTemplate</name></template><type>AppPage</type>`
      )
    );
  const app = (lbl: string): void =>
    write(
      'applications/SfDfQa_App.app-meta.xml',
      xml(
        'CustomApplication',
        `<formFactors>Large</formFactors><isNavAutoTempTabsDisabled>false</isNavAutoTempTabsDisabled><isNavPersonalizationDisabled>false</isNavPersonalizationDisabled><isNavTabPersistenceDisabled>false</isNavTabPersistenceDisabled><label>${lbl}</label><navType>Standard</navType><tabs>${obj}</tabs><uiType>Lightning</uiType>`
      )
    );
  const staticResourceMeta = (name: string, contentType: string): void =>
    write(`staticresources/${name}.resource-meta.xml`, xml('StaticResource', `<cacheControl>Private</cacheControl><contentType>${contentType}</contentType>`));
  const fieldTranslation = (name: string, lbl: string): void =>
    write(`objectTranslations/${obj}-${language}/${name}.fieldTranslation-meta.xml`, xml('CustomFieldTranslation', `<label>${lbl}</label><name>${name}</name>`));
  const labelTranslations = (entries: Array<[string, string]>): void =>
    write(
      `translations/${language}.translation-meta.xml`,
      xml('Translations', entries.map(([n, v]) => `<customLabels><label>${v}</label><name>${n}</name></customLabels>`).join(''))
    );
  const profile = (fields: Array<[string, boolean]>, classes: string[]): void =>
    write(
      'profiles/SfDfQa_Profile.profile-meta.xml',
      xml(
        'Profile',
        [
          ...classes.map((c) => `<classAccesses><apexClass>${c}</apexClass><enabled>true</enabled></classAccesses>`),
          '<custom>true</custom>',
          ...fields.map(
            ([f, editable]) =>
              `<fieldPermissions><editable>${editable}</editable><field>${obj}.${f}</field><readable>true</readable></fieldPermissions>`
          ),
          `<layoutAssignments><layout>${obj}-SfDfQa Layout</layout></layoutAssignments>`,
          `<objectPermissions><allowCreate>true</allowCreate><allowDelete>false</allowDelete><allowEdit>true</allowEdit><allowRead>true</allowRead><modifyAllRecords>false</modifyAllRecords><object>${obj}</object><viewAllRecords>false</viewAllRecords></objectPermissions>`,
          '<userLicense>Salesforce</userLicense>',
        ].join('\n')
      )
    );
  const permissionSetGroup = (permissionSets: string[]): void =>
    write(
      'permissionsetgroups/SfDfQa_PSG.permissionsetgroup-meta.xml',
      xml(
        'PermissionSetGroup',
        `<label>SfDfQa PSG</label><mutingPermissionSets>SfDfQa_Mute</mutingPermissionSets>${permissionSets
          .map((ps) => `<permissionSets>${ps}</permissionSets>`)
          .join('')}`
      )
    );
  // Muting object Edit or Delete is refused by Salesforce ("invalid parameter value"), muting a field's Edit is not.
  const mutingPermissionSet = (muteF1Edit: boolean): void =>
    write(
      'mutingpermissionsets/SfDfQa_Mute.mutingpermissionset-meta.xml',
      xml(
        'MutingPermissionSet',
        `${muteF1Edit ? `<fieldPermissions><editable>true</editable><field>${obj}.F1__c</field><readable>false</readable></fieldPermissions>` : ''}<label>SfDfQa Mute</label><objectPermissions><allowCreate>true</allowCreate><allowDelete>false</allowDelete><allowEdit>false</allowEdit><allowRead>false</allowRead><modifyAllRecords>false</modifyAllRecords><object>${obj}</object><viewAllRecords>false</viewAllRecords></objectPermissions>`
      )
    );
  const globalValueSet = (values: string[]): void =>
    write(
      `globalValueSets/${names.valueSet}.globalValueSet-meta.xml`,
      xml(
        'GlobalValueSet',
        `${values.map((v) => `<customValue><fullName>${v}</fullName><default>false</default><label>${v}</label></customValue>`).join('')}<masterLabel>SfDfQa GVS</masterLabel><sorted>false</sorted>`
      )
    );
  const businessProcess = (values: string[]): void =>
    write(
      'objects/Opportunity/businessProcesses/SfDfQa_BP.businessProcess-meta.xml',
      xml(
        'BusinessProcess',
        `<fullName>SfDfQa_BP</fullName><isActive>true</isActive>${values.map((v) => `<values><fullName>${v}</fullName><default>false</default></values>`).join('')}`
      )
    );
  // The org's LeadSource values plus one SfDfQa value.
  const leadSource = (lbl: string): void => {
    const original = standard!.leadSourceXml;
    const at = original.lastIndexOf('</standardValue>') + '</standardValue>'.length;
    write(
      'standardValueSets/LeadSource.standardValueSet-meta.xml',
      `${original.slice(0, at)}\n    <standardValue><fullName>SfDfQa_Source</fullName><default>false</default><label>${lbl}</label></standardValue>${original.slice(at)}`
    );
  };

  const phases = {
    init(): void {
      mkdirSync(repo, { recursive: true });
      git('init', '-q');
      git('config', 'user.email', 'qa@example.com');
      git('config', 'user.name', 'QA');
      git('config', 'core.autocrlf', 'false');
      writeFileSync(
        path.join(repo, 'sfdx-project.json'),
        JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: API }, null, 2)
      );
      writeFileSync(path.join(repo, '.gitignore'), 'out*\n.sf/\n.sfdx/\n');
      commit('init');
    },

    p1(): void {
      apexClass('SfDfQaA', "public static String v() { return 'v1'; }");
      apexClass('SfDfQaB', "public static String v() { return 'b'; }");
      apexClass('SfDfQaC', "public static String v() { return 'c'; }");
      trigger('// v1');
      vfPage('SfDfQaPage', 'v1');
      vfPage('SfDfQaPage2', 'second');
      vfComponent('v1');
      lwc('sfDfQaCmp', 'SfDfQaCmp', '<p class="title">QA v1</p>', '.title { color: red; }\n', true);
      lwc('sfDfQaOther', 'SfDfQaOther', '<p>other</p>', undefined, false);
      write('aura/SfDfQaAura/SfDfQaAura.cmp', '<aura:component>\n    <p>QA v1</p>\n</aura:component>\n');
      write('aura/SfDfQaAura/SfDfQaAuraController.js', '({\n    doInit: function (component, event, helper) {}\n})\n');
      write('aura/SfDfQaAura/SfDfQaAuraHelper.js', '({\n    noop: function () {}\n})\n');
      write('aura/SfDfQaAura/SfDfQaAura.css', '.THIS {\n    color: red;\n}\n');
      write('aura/SfDfQaAura/SfDfQaAura.cmp-meta.xml', xml('AuraDefinitionBundle', `<apiVersion>${API}</apiVersion><description>QA</description>`));
      write(
        `objects/${obj}/${obj}.object-meta.xml`,
        xml(
          'CustomObject',
          '<deploymentStatus>Deployed</deploymentStatus><enableActivities>false</enableActivities><enableBulkApi>true</enableBulkApi><enableFeeds>false</enableFeeds><enableHistory>false</enableHistory><enableReports>true</enableReports><enableSearch>false</enableSearch><enableSharing>true</enableSharing><enableStreamingApi>true</enableStreamingApi><externalSharingModel>Private</externalSharingModel><label>SfDfQa Obj</label><nameField><label>Name</label><type>Text</type></nameField><pluralLabel>SfDfQa Objs</pluralLabel><sharingModel>Private</sharingModel>'
        )
      );
      textField('F1__c', 'F1 v1');
      textField('F2__c', 'F2');
      textField('F3__c', 'F3');
      statusField(['A', 'B', 'C']);
      recordType('RT1', 'RT1 v1', ['A', 'B']);
      recordType('RT2', 'RT2', ['A']);
      listView('All_SfDfQa', 'Everything');
      listView('Mine_SfDfQa', 'Mine');
      validationRule('VR1', 'Too long v1');
      validationRule('VR2', 'Second rule');
      webLink('v1');
      compactLayout(['Name'], 'v1');
      fieldSet('v1');
      layout(['F1__c', 'F2__c']);
      write(
        `objects/${setting}__mdt/${setting}__mdt.object-meta.xml`,
        xml('CustomObject', '<label>SfDfQa Setting</label><pluralLabel>SfDfQa Settings</pluralLabel><visibility>Public</visibility>')
      );
      write(
        `objects/${setting}__mdt/fields/Value__c.field-meta.xml`,
        xml('CustomField', '<fullName>Value__c</fullName><externalId>false</externalId><fieldManageability>DeveloperControlled</fieldManageability><label>Value</label><length>50</length><required>false</required><type>Text</type><unique>false</unique>')
      );
      cmdtRecord('Rec1', 'one v1');
      cmdtRecord('Rec2', 'two');
      flow(names.flow, 'SfDfQa Flow v1');
      flow(names.flow2, 'SfDfQa Flow2');
      customPermission('SfDfQa_Perm');
      permissionSet(['SfDfQaA', 'SfDfQaB'], [['F1__c', true], ['F2__c', true]], ['SfDfQa_Perm']);
      write('labels/CustomLabels.labels-meta.xml', xml('CustomLabels', [label('SfDfQa_L1', 'One v1'), label('SfDfQa_L2', 'Two'), label('SfDfQa_L3', 'Three')].join('\n')));
      write(`tabs/${obj}.tab-meta.xml`, xml('CustomTab', '<customObject>true</customObject><motif>Custom20: Airplane</motif>'));
      app('SfDfQa App v1');
      quickAction('SfDfQa Update v1');
      write('groups/SfDfQa_Group.group-meta.xml', xml('Group', '<doesIncludeBosses>false</doesIncludeBosses><name>SfDfQa Group</name>'));
      write(`sharingRules/${obj}.sharingRules-meta.xml`, xml('SharingRules', sharingRule('SR1', 'Read') + sharingRule('SR2', 'Read')));
      write(
        `workflows/${obj}.workflow-meta.xml`,
        xml('Workflow', fieldUpdate('FU1', 'v1') + fieldUpdate('FU2', 'two') + workflowRule('WR1', 'FU1', 'true') + workflowRule('WR2', 'FU2', 'false'))
      );
      write('email/SfDfQa_Folder.emailFolder-meta.xml', xml('EmailFolder', '<accessType>Public</accessType><name>SfDfQa Folder</name><publicFolderAccess>ReadWrite</publicFolderAccess>'));
      emailTemplate('SfDfQa_Tpl1', 'Hello v1');
      emailTemplate('SfDfQa_Tpl2', 'Second');
      write('reports/SfDfQa_Reports.reportFolder-meta.xml', xml('ReportFolder', '<name>SfDfQa Reports</name>'));
      report('SfDfQa Report v1');
      flexiPage('QA v1');
      staticResourceMeta('SfDfQaRes', 'application/zip');
      write('staticresources/SfDfQaRes/css/app.css', 'body { color: red; }\n');
      write('staticresources/SfDfQaRes/js/app.js', "console.log('v1');\n");
      staticResourceMeta('SfDfQaTxt', 'text/plain');
      write('staticresources/SfDfQaTxt.txt', 'v1\n');
      write(
        `objectTranslations/${obj}-${language}/${obj}-${language}.objectTranslation-meta.xml`,
        xml('CustomObjectTranslation', '<caseValues><plural>false</plural><value>Objet QA</value></caseValues><caseValues><plural>true</plural><value>Objets QA</value></caseValues><gender>Masculine</gender><startsWith>Consonant</startsWith>')
      );
      fieldTranslation('F1__c', 'Champ 1 v1');
      fieldTranslation('F2__c', 'Champ 2');
      fieldTranslation('F3__c', 'Champ 3');
      labelTranslations([
        ['SfDfQa_L1', 'Un v1'],
        ['SfDfQa_L2', 'Deux'],
      ]);
      profile([['F1__c', true], ['F3__c', true]], ['SfDfQaA']);
      mutingPermissionSet(false);
      permissionSetGroup(['SfDfQa_PS']);
      globalValueSet(['X', 'Y']);
      if (standard) {
        businessProcess(['Prospecting', 'Closed Won', 'Closed Lost']);
        leadSource('SfDfQa Source v1');
      }
      commit('p1');
    },

    p2(): void {
      apexClass('SfDfQaA', "public static String v() { return 'v2'; }");
      remove('classes/SfDfQaB.cls');
      remove('classes/SfDfQaB.cls-meta.xml');
      git('add', '-A');
      git('mv', `${SOURCE_DIR}/classes/SfDfQaC.cls`, `${SOURCE_DIR}/classes/SfDfQaD.cls`);
      git('mv', `${SOURCE_DIR}/classes/SfDfQaC.cls-meta.xml`, `${SOURCE_DIR}/classes/SfDfQaD.cls-meta.xml`);
      write('classes/SfDfQaD.cls', "public with sharing class SfDfQaD {\n    public static String v() { return 'c'; }\n}\n");
      trigger('// v2');
      vfPage('SfDfQaPage', 'v2');
      remove('pages/SfDfQaPage2.page');
      remove('pages/SfDfQaPage2.page-meta.xml');
      vfComponent('v2');
      remove('lwc/sfDfQaCmp/sfDfQaCmp.css');
      write('lwc/sfDfQaCmp/sfDfQaCmp.html', '<template><p>QA v2</p></template>\n');
      remove('lwc/sfDfQaOther');
      remove('aura/SfDfQaAura/SfDfQaAuraHelper.js');
      textField('F1__c', 'F1 v2');
      remove(`objects/${obj}/fields/F2__c.field-meta.xml`);
      layout(['F1__c']);
      statusField(['A', 'B', 'C', 'D']);
      recordType('RT1', 'RT1 v2', ['A', 'B', 'D']);
      remove(`objects/${obj}/recordTypes/RT2.recordType-meta.xml`);
      remove(`objects/${obj}/listViews/Mine_SfDfQa.listView-meta.xml`);
      validationRule('VR1', 'Too long v2');
      remove(`objects/${obj}/validationRules/VR2.validationRule-meta.xml`);
      webLink('v2');
      compactLayout(['Name', 'F1__c'], 'v2');
      fieldSet('v2');
      cmdtRecord('Rec1', 'one v2');
      remove(`customMetadata/${setting}.Rec2.md-meta.xml`);
      cmdtRecord('Rec3', 'three');
      flow(names.flow, 'SfDfQa Flow v2');
      remove(`flows/${names.flow2}.flow-meta.xml`);
      customPermission('SfDfQa_Perm2');
      permissionSet(['SfDfQaA', 'SfDfQaD'], [['F1__c', false]], ['SfDfQa_Perm', 'SfDfQa_Perm2']);
      write('labels/CustomLabels.labels-meta.xml', xml('CustomLabels', [label('SfDfQa_L1', 'One v2'), label('SfDfQa_L3', 'Three'), label('SfDfQa_L4', 'Four')].join('\n')));
      app('SfDfQa App v2');
      quickAction('SfDfQa Update v2');
      write(`sharingRules/${obj}.sharingRules-meta.xml`, xml('SharingRules', sharingRule('SR1', 'Edit')));
      write(`workflows/${obj}.workflow-meta.xml`, xml('Workflow', fieldUpdate('FU1', 'v2') + workflowRule('WR1', 'FU1', 'true')));
      emailTemplate('SfDfQa_Tpl1', 'Hello v2');
      remove('email/SfDfQa_Folder/SfDfQa_Tpl2.email');
      remove('email/SfDfQa_Folder/SfDfQa_Tpl2.email-meta.xml');
      report('SfDfQa Report v2');
      flexiPage('QA v2');
      remove('staticresources/SfDfQaRes/css/app.css');
      write('staticresources/SfDfQaRes/js/app.js', "console.log('v2');\n");
      write('staticresources/SfDfQaTxt.txt', 'v2\n');
      // Only one field translation changes: the parent object translation must still ship, without F3's unchanged
      // translation, which must stay in the org.
      fieldTranslation('F1__c', 'Champ 1 v2');
      remove(`objectTranslations/${obj}-${language}/F2__c.fieldTranslation-meta.xml`);
      labelTranslations([['SfDfQa_L1', 'Un v2']]);
      // F1 loses edit, F3 is removed from the file (a profile deploy never revokes what it does not cite), a new class.
      profile([['F1__c', false]], ['SfDfQaA', 'SfDfQaD']);
      mutingPermissionSet(true);
      write('permissionsets/SfDfQa_PS2.permissionset-meta.xml', xml('PermissionSet', '<hasActivationRequired>false</hasActivationRequired><label>SfDfQa PS2</label>'));
      permissionSetGroup(['SfDfQa_PS', 'SfDfQa_PS2']);
      globalValueSet(['X', 'Z']);
      if (standard) {
        businessProcess(['Prospecting', 'Qualification', 'Closed Won', 'Closed Lost']);
        leadSource('SfDfQa Source v2');
      }
      commit('p2');
    },

    p2b(): void {
      permissionSet(['SfDfQaD'], [], ['SfDfQa_Perm']);
      commit('p2b');
    },

    p3(): void {
      remove('');
      mkdirSync(path.join(repo, SOURCE_DIR), { recursive: true });
      writeFileSync(path.join(repo, SOURCE_DIR, '.gitkeep'), '');
      commit('p3');
    },
  };

  return phases;
};
