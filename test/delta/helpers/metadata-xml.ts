// Small builders for metadata source files, formatted like `sf project retrieve start` writes them.

const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

export const metadataXml = (root: string, ...elements: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<${root} ${NS}>\n${elements
    .map((element) => `    ${element}`)
    .join('\n')}\n</${root}>\n`;

// <name>value</name> for each entry; an array repeats the element.
export const elements = (values: Record<string, string | string[] | undefined>): string =>
  Object.entries(values)
    .flatMap(([name, value]) =>
      (value === undefined ? [] : Array.isArray(value) ? value : [value]).map((text) => `<${name}>${text}</${name}>`)
    )
    .join('');

export const element = (name: string, values: Record<string, string | string[] | undefined>): string =>
  `<${name}>${elements(values)}</${name}>`;

// --- RecordType -------------------------------------------------------------------------------------------------

export type PicklistSelection = { picklist: string; values: string[]; defaultValue?: string };

export const rtPicklist = ({ picklist, values, defaultValue }: PicklistSelection): string =>
  `<picklistValues><picklist>${picklist}</picklist>${values
    .map(
      (value) => `<values><fullName>${value}</fullName><default>${String(value === defaultValue)}</default></values>`
    )
    .join('')}</picklistValues>`;

export const recordTypeXml = (
  name: string,
  options: {
    label?: string;
    active?: boolean;
    description?: string;
    businessProcess?: string;
    compactLayoutAssignment?: string;
    picklists?: PicklistSelection[];
  } = {}
): string =>
  metadataXml(
    'RecordType',
    `<fullName>${name}</fullName>`,
    `<active>${String(options.active ?? true)}</active>`,
    ...(options.businessProcess ? [`<businessProcess>${options.businessProcess}</businessProcess>`] : []),
    ...(options.compactLayoutAssignment
      ? [`<compactLayoutAssignment>${options.compactLayoutAssignment}</compactLayoutAssignment>`]
      : []),
    ...(options.description ? [`<description>${options.description}</description>`] : []),
    `<label>${options.label ?? name}</label>`,
    ...(options.picklists ?? []).map(rtPicklist)
  );

// --- Objects and fields -----------------------------------------------------------------------------------------

export const customObjectXml = (label: string, extra: string[] = []): string =>
  metadataXml(
    'CustomObject',
    `<deploymentStatus>Deployed</deploymentStatus>`,
    `<label>${label}</label>`,
    `<nameField><label>Name</label><type>Text</type></nameField>`,
    `<pluralLabel>${label}s</pluralLabel>`,
    `<sharingModel>ReadWrite</sharingModel>`,
    ...extra
  );

export const textFieldXml = (name: string, label = name, length = 80): string =>
  metadataXml(
    'CustomField',
    `<fullName>${name}</fullName>`,
    `<label>${label}</label>`,
    `<length>${length}</length>`,
    `<type>Text</type>`
  );

export const numberFieldXml = (name: string, label = name): string =>
  metadataXml(
    'CustomField',
    `<fullName>${name}</fullName>`,
    `<label>${label}</label>`,
    `<precision>18</precision>`,
    `<scale>2</scale>`,
    `<type>Number</type>`
  );

export const picklistFieldXml = (name: string, values: string[]): string =>
  metadataXml(
    'CustomField',
    `<fullName>${name}</fullName>`,
    `<label>${name}</label>`,
    `<type>Picklist</type>`,
    `<valueSet><valueSetDefinition>${values
      .map((value) => `<value><fullName>${value}</fullName><default>false</default><label>${value}</label></value>`)
      .join('')}</valueSetDefinition></valueSet>`
  );

// --- Profile and permission sets --------------------------------------------------------------------------------

export const fieldPermission = (field: string, editable = true, readable = true): string =>
  element('fieldPermissions', { editable: String(editable), field, readable: String(readable) });

export const objectPermission = (object: string, read = true, edit = true): string =>
  element('objectPermissions', {
    allowCreate: String(edit),
    allowDelete: 'false',
    allowEdit: String(edit),
    allowRead: String(read),
    modifyAllRecords: 'false',
    object,
    viewAllRecords: 'false',
  });

export const classAccess = (apexClass: string, enabled = true): string =>
  element('classAccesses', { apexClass, enabled: String(enabled) });
export const pageAccess = (apexPage: string, enabled = true): string =>
  element('pageAccesses', { apexPage, enabled: String(enabled) });
export const tabVisibility = (tab: string, visibility = 'DefaultOn'): string =>
  element('tabVisibilities', { tab, visibility });
export const userPermission = (name: string, enabled = true): string =>
  element('userPermissions', { enabled: String(enabled), name });
export const applicationVisibility = (application: string, visible = true, isDefault = false): string =>
  element('applicationVisibilities', {
    application,
    default: String(isDefault),
    visible: String(visible),
  });
export const recordTypeVisibility = (recordType: string, visible = true, isDefault = false): string =>
  element('recordTypeVisibilities', {
    default: String(isDefault),
    recordType,
    visible: String(visible),
  });
export const layoutAssignment = (layout: string, recordType?: string): string =>
  element('layoutAssignments', { layout, recordType });
export const loginIpRange = (startAddress: string, endAddress: string): string =>
  element('loginIpRanges', { endAddress, startAddress });
export const customPermissionAccess = (name: string, enabled = true): string =>
  element('customPermissions', { enabled: String(enabled), name });

export const profileXml = (...items: string[]): string =>
  metadataXml('Profile', ...items, '<custom>true</custom>', '<userLicense>Salesforce</userLicense>');

export const permissionSetXml = (label: string, ...items: string[]): string =>
  metadataXml(
    'PermissionSet',
    ...items,
    '<hasActivationRequired>false</hasActivationRequired>',
    `<label>${label}</label>`
  );

export const permissionSetGroupXml = (label: string, permissionSets: string[]): string =>
  metadataXml(
    'PermissionSetGroup',
    `<label>${label}</label>`,
    ...permissionSets.map((name) => `<permissionSets>${name}</permissionSets>`),
    '<status>Updated</status>'
  );

export const mutingPermissionSetXml = (label: string, ...items: string[]): string =>
  metadataXml('MutingPermissionSet', ...items, `<label>${label}</label>`);

// --- Translations -----------------------------------------------------------------------------------------------

export const labelTranslation = (name: string, label: string): string => element('customLabels', { label, name });

export const translationsXml = (...items: string[]): string => metadataXml('Translations', ...items);

export const objectTranslationXml = (value: string): string =>
  metadataXml('CustomObjectTranslation', `<caseValues><plural>false</plural><value>${value}</value></caseValues>`);

export const fieldTranslationXml = (name: string, label: string): string =>
  metadataXml('CustomFieldTranslation', `<label>${label}</label>`, `<name>${name}</name>`);

// --- Flow -------------------------------------------------------------------------------------------------------

export const flowXml = (label: string, status = 'Active', description?: string): string =>
  metadataXml(
    'Flow',
    `<apiVersion>62.0</apiVersion>`,
    ...(description ? [`<description>${description}</description>`] : []),
    `<label>${label}</label>`,
    `<processType>AutoLaunchedFlow</processType>`,
    `<status>${status}</status>`
  );

// --- Labels and rules -------------------------------------------------------------------------------------------

export const customLabel = (name: string, value: string, protectedLabel = false): string =>
  element('labels', {
    fullName: name,
    language: 'en_US',
    protected: String(protectedLabel),
    shortDescription: name,
    value,
  });

export const customLabelsXml = (...labels: string[]): string => metadataXml('CustomLabels', ...labels);

export const workflowRule = (name: string, formula = 'true', active = true): string =>
  element('rules', {
    fullName: name,
    active: String(active),
    formula,
    triggerType: 'onCreateOnly',
  });
export const workflowFieldUpdate = (name: string, value: string): string =>
  element('fieldUpdates', {
    fullName: name,
    field: 'Description',
    literalValue: value,
    name,
    notifyAssignee: 'false',
    operation: 'Literal',
    protected: 'false',
  });
export const workflowAlert = (name: string, template: string): string =>
  element('alerts', {
    fullName: name,
    description: name,
    protected: 'false',
    recipients: '<type>owner</type>',
    senderType: 'CurrentUser',
    template,
  });

export const workflowXml = (...items: string[]): string => metadataXml('Workflow', ...items);

export const sharingCriteriaRule = (name: string, accessLevel = 'Read'): string =>
  element('sharingCriteriaRules', {
    fullName: name,
    accessLevel,
    label: name,
    sharedTo: '<allInternalUsers></allInternalUsers>',
    criteriaItems: '<field>Name</field><operation>notEqual</operation><value></value>',
  });
export const sharingOwnerRule = (name: string, accessLevel = 'Read'): string =>
  element('sharingOwnerRules', {
    fullName: name,
    accessLevel,
    label: name,
    sharedTo: '<allInternalUsers></allInternalUsers>',
    sharedFrom: '<allInternalUsers></allInternalUsers>',
  });

export const sharingRulesXml = (...rules: string[]): string => metadataXml('SharingRules', ...rules);

// --- Apex -------------------------------------------------------------------------------------------------------

export const apexMetaXml = (root: 'ApexClass' | 'ApexTrigger', apiVersion = '62.0'): string =>
  metadataXml(root, `<apiVersion>${apiVersion}</apiVersion>`, '<status>Active</status>');

export const apexClass = (name: string, body = '', apiVersion = '62.0'): Record<string, string> => ({
  [`classes/${name}.cls`]: `public with sharing class ${name} {${body}}\n`,
  [`classes/${name}.cls-meta.xml`]: apexMetaXml('ApexClass', apiVersion),
});

export const apexTrigger = (name: string, object: string, body = '', apiVersion = '62.0'): Record<string, string> => ({
  [`triggers/${name}.trigger`]: `trigger ${name} on ${object} (before insert) {${body}}\n`,
  [`triggers/${name}.trigger-meta.xml`]: apexMetaXml('ApexTrigger', apiVersion),
});

// --- Bundles ----------------------------------------------------------------------------------------------------

export const lwcBundle = (
  name: string,
  js = `export default class extends LightningElement {}`
): Record<string, string> => ({
  [`lwc/${name}/${name}.js`]: `import { LightningElement } from 'lwc';\n${js}\n`,
  [`lwc/${name}/${name}.html`]: '<template></template>\n',
  [`lwc/${name}/${name}.js-meta.xml`]: metadataXml(
    'LightningComponentBundle',
    '<apiVersion>62.0</apiVersion>',
    '<isExposed>false</isExposed>'
  ),
});

export const auraBundle = (name: string, markup = '<aura:component></aura:component>'): Record<string, string> => ({
  [`aura/${name}/${name}.cmp`]: `${markup}\n`,
  [`aura/${name}/${name}Controller.js`]: '({ init: function () {} })\n',
  [`aura/${name}/${name}Helper.js`]: '({ load: function () {} })\n',
  [`aura/${name}/${name}.cmp-meta.xml`]: metadataXml(
    'AuraDefinitionBundle',
    '<apiVersion>62.0</apiVersion>',
    `<description>${name}</description>`
  ),
});

// --- Pages and actions ------------------------------------------------------------------------------------------

export const layoutXml = (...fields: string[]): string =>
  metadataXml(
    'Layout',
    `<layoutSections><customLabel>false</customLabel><detailHeading>false</detailHeading><editHeading>true</editHeading><label>Information</label><layoutColumns>${fields
      .map((field) => `<layoutItems><behavior>Edit</behavior><field>${field}</field></layoutItems>`)
      .join('')}</layoutColumns><style>OneColumn</style></layoutSections>`
  );

export const flexiPageXml = (label: string, template = 'flexipage:recordHomeTemplateDesktop'): string =>
  metadataXml(
    'FlexiPage',
    `<masterLabel>${label}</masterLabel>`,
    '<sobjectType>Invoice__c</sobjectType>',
    `<template><name>${template}</name></template>`,
    '<type>RecordPage</type>'
  );

export const quickActionXml = (label: string, type = 'Update'): string =>
  metadataXml(
    'QuickAction',
    `<label>${label}</label>`,
    '<optionsCreateFeedItem>false</optionsCreateFeedItem>',
    `<type>${type}</type>`
  );

export const compactLayoutXml = (name: string, fields: string[]): string =>
  metadataXml(
    'CompactLayout',
    `<fullName>${name}</fullName>`,
    ...fields.map((field) => `<fields>${field}</fields>`),
    `<label>${name}</label>`
  );

export const webLinkXml = (name: string, url: string): string =>
  metadataXml(
    'WebLink',
    `<fullName>${name}</fullName>`,
    '<availability>online</availability>',
    '<displayType>button</displayType>',
    '<linkType>url</linkType>',
    `<masterLabel>${name}</masterLabel>`,
    '<openType>replace</openType>',
    '<protected>false</protected>',
    `<url>${url}</url>`
  );

export const fieldSetXml = (name: string, fields: string[]): string =>
  metadataXml(
    'FieldSet',
    `<fullName>${name}</fullName>`,
    `<description>${name}</description>`,
    ...fields.map(
      (field) =>
        `<displayedFields><field>${field}</field><isFieldManaged>false</isFieldManaged><isRequired>false</isRequired></displayedFields>`
    ),
    `<label>${name}</label>`
  );

export const businessProcessXml = (name: string, values: string[]): string =>
  metadataXml(
    'BusinessProcess',
    `<fullName>${name}</fullName>`,
    '<isActive>true</isActive>',
    ...values.map((value) => `<values><fullName>${value}</fullName><default>false</default></values>`)
  );

// --- Custom metadata and value sets -----------------------------------------------------------------------------

// Values as [field, value] pairs: field names such as Value__c are not camel case.
export const customMetadataRecordXml = (label: string, values: Array<[string, string]>): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n    <label>${label}</label>\n    <protected>false</protected>\n${values
    .map(
      ([field, value]) => `    <values><field>${field}</field><value xsi:type="xsd:string">${value}</value></values>`
    )
    .join('\n')}\n</CustomMetadata>\n`;

export const globalValueSetXml = (label: string, values: string[]): string =>
  metadataXml(
    'GlobalValueSet',
    ...values.map(
      (value) =>
        `<customValue><fullName>${value}</fullName><default>false</default><label>${value}</label></customValue>`
    ),
    `<masterLabel>${label}</masterLabel>`,
    '<sorted>false</sorted>'
  );

export const standardValueSetXml = (values: string[]): string =>
  metadataXml(
    'StandardValueSet',
    '<sorted>false</sorted>',
    ...values.map(
      (value) =>
        `<standardValue><fullName>${value}</fullName><default>false</default><label>${value}</label></standardValue>`
    )
  );
