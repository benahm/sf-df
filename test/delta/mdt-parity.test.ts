import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { retrieveProfiles } from '../../src/retrieve/profile-retrieve.js';
import { fakeConnection } from '../retrieve/fake-org.js';
import { useDeltaRepo } from './helpers/delta-repo.js';

// Behaviours carried over from `sfdx mdt:git:delta` (benahm/sfdx-mdt-plugin).

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const exists = async (absolutePath: string): Promise<boolean> =>
  stat(absolutePath).then(
    () => true,
    () => false
  );

describe('mdt:git:delta parity', () => {
  const ctx = useDeltaRepo();

  it('writes partial sharing rules and lists deleted rules by child type', async () => {
    const rule = (name: string, label: string): string =>
      `<sharingCriteriaRules><fullName>${name}</fullName><accessLevel>Read</accessLevel><label>${label}</label></sharingCriteriaRules>`;
    const file = 'sharingRules/Account.sharingRules-meta.xml';

    await ctx.repo.baseline({
      [file]: `${XML_HEADER}<SharingRules ${NS}>${rule('Kept', 'Kept')}${rule('Changed', 'Before')}${rule('Removed', 'Removed')}</SharingRules>\n`,
    });
    await ctx.repo.write({
      [file]: `${XML_HEADER}<SharingRules ${NS}>${rule('Kept', 'Kept')}${rule('Changed', 'After')}${rule('Added', 'Added')}</SharingRules>\n`,
    });

    const delta = await ctx.repo.delta();
    const packageXml = await delta.packageFile(file);
    const destructiveXml = await delta.destructiveFile(file);
    const destructiveManifest = await readFile(delta.result.destructiveManifestPath!, 'utf8');

    expect(delta.result.countsByStrategy).to.have.property('sharingRules');
    expect(packageXml).to.contain('<fullName>Changed</fullName>');
    expect(packageXml).to.contain('<fullName>Added</fullName>');
    expect(packageXml).not.to.contain('<fullName>Kept</fullName>');
    expect(destructiveXml).to.contain('<fullName>Removed</fullName>');
    expect(destructiveManifest).to.contain('<name>SharingCriteriaRule</name>');
    expect(destructiveManifest).to.contain('<members>Account.Removed</members>');
    expect(destructiveManifest).not.to.contain('<name>SharingRules</name>');
    expect(await readFile(path.join(ctx.repo.root, 'tmp-output', 'destructive', 'package.xml'), 'utf8')).not.to.contain(
      '<types>'
    );
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

      await ctx.repo.baseline({
        [file]: `${XML_HEADER}<${typeName} ${NS}>${item('Stable', 'true')}${item('Toggled', 'false')}${item('Dropped', 'true')}</${typeName}>\n`,
      });
      await ctx.repo.write({
        [file]: `${XML_HEADER}<${typeName} ${NS}>${item('Stable', 'true')}${item('Toggled', 'true')}</${typeName}>\n`,
      });

      const delta = await ctx.repo.delta();
      const packageXml = await delta.packageFile(file);
      const destructiveManifest = await readFile(delta.result.destructiveManifestPath!, 'utf8');

      expect(packageXml).to.contain('<fullName>Toggled</fullName>');
      expect(packageXml).not.to.contain('<fullName>Stable</fullName>');
      expect(await delta.destructiveFile(file)).to.contain('<fullName>Dropped</fullName>');
      expect(destructiveManifest).to.contain('<members>Case.Dropped</members>');
    });
  }

  it('lists deleted workflow rules by child type', async () => {
    const rule = (name: string): string =>
      `<rules><fullName>${name}</fullName><active>true</active><triggerType>onCreateOnly</triggerType></rules>`;
    const file = 'workflows/Account.workflow-meta.xml';

    await ctx.repo.baseline({ [file]: `${XML_HEADER}<Workflow ${NS}>${rule('Keep')}${rule('Drop')}</Workflow>\n` });
    await ctx.repo.write({ [file]: `${XML_HEADER}<Workflow ${NS}>${rule('Keep')}</Workflow>\n` });

    const delta = await ctx.repo.delta();
    const destructiveManifest = await readFile(delta.result.destructiveManifestPath!, 'utf8');

    expect(destructiveManifest).to.contain('<name>WorkflowRule</name>');
    expect(destructiveManifest).to.contain('<members>Account.Drop</members>');
  });

  it('copies the whole LWC bundle without __tests__', async () => {
    await ctx.repo.baseline({
      'lwc/myCmp/myCmp.js': 'export default class MyCmp {}\n',
      'lwc/myCmp/myCmp.html': '<template></template>\n',
      'lwc/myCmp/myCmp.js-meta.xml': `${XML_HEADER}<LightningComponentBundle ${NS}><apiVersion>61.0</apiVersion></LightningComponentBundle>\n`,
      'lwc/myCmp/__tests__/myCmp.test.js': "describe('myCmp', () => {});\n",
    });
    await ctx.repo.write({ 'lwc/myCmp/myCmp.js': 'export default class MyCmp { updated = true; }\n' });

    const delta = await ctx.repo.delta();

    expect(delta.packageFiles).to.include('lwc/myCmp/myCmp.js');
    expect(delta.packageFiles).to.include('lwc/myCmp/myCmp.html');
    expect(delta.packageFiles).to.include('lwc/myCmp/myCmp.js-meta.xml');
    expect(delta.packageFiles).not.to.include('lwc/myCmp/__tests__/myCmp.test.js');
    expect(await readFile(delta.result.packageManifestPath, 'utf8')).to.contain('<members>myCmp</members>');
  });

  it('copies the parent object translation with a changed field translation', async () => {
    const fieldTranslation = (label: string): string =>
      `${XML_HEADER}<CustomFieldTranslation ${NS}><label>${label}</label><name>Amount__c</name></CustomFieldTranslation>\n`;
    await ctx.repo.baseline({
      'objectTranslations/Invoice__c-fr/Invoice__c-fr.objectTranslation-meta.xml': `${XML_HEADER}<CustomObjectTranslation ${NS}><caseValues><plural>false</plural><value>Facture</value></caseValues></CustomObjectTranslation>\n`,
      'objectTranslations/Invoice__c-fr/Amount__c.fieldTranslation-meta.xml': fieldTranslation('Montant'),
    });
    await ctx.repo.write({
      'objectTranslations/Invoice__c-fr/Amount__c.fieldTranslation-meta.xml': fieldTranslation('Montant TTC'),
    });

    const delta = await ctx.repo.delta();

    expect(await delta.packageFile('objectTranslations/Invoice__c-fr/Amount__c.fieldTranslation-meta.xml')).to.contain(
      'Montant TTC'
    );
    expect(delta.packageFiles).to.include('objectTranslations/Invoice__c-fr/Invoice__c-fr.objectTranslation-meta.xml');
    expect(await readFile(delta.result.packageManifestPath, 'utf8')).to.contain('<members>Invoice__c-fr</members>');
  });

  it('copies a folder static resource with its meta file', async () => {
    await ctx.repo.baseline({
      'staticresources/assets.resource-meta.xml': `${XML_HEADER}<StaticResource ${NS}><cacheControl>Private</cacheControl><contentType>application/zip</contentType></StaticResource>\n`,
      'staticresources/assets/css/app.css': 'body { color: red; }\n',
      'staticresources/assets/js/app.js': 'console.log(1);\n',
    });
    await ctx.repo.write({ 'staticresources/assets/css/app.css': 'body { color: blue; }\n' });

    const delta = await ctx.repo.delta();

    expect(await delta.packageFile('staticresources/assets/css/app.css')).to.contain('blue');
    expect(delta.packageFiles).to.include('staticresources/assets/js/app.js');
    expect(delta.packageFiles).to.include('staticresources/assets.resource-meta.xml');
  });

  it('copies the source file when only its meta file changed', async () => {
    const meta = (version: string): string =>
      `${XML_HEADER}<ApexClass ${NS}><apiVersion>${version}</apiVersion><status>Active</status></ApexClass>\n`;
    await ctx.repo.baseline({
      'classes/MyClass.cls': 'public class MyClass {}\n',
      'classes/MyClass.cls-meta.xml': meta('60.0'),
    });
    await ctx.repo.write({ 'classes/MyClass.cls-meta.xml': meta('61.0') });

    const delta = await ctx.repo.delta();

    expect(delta.packageFiles).to.include('classes/MyClass.cls');
    expect(await delta.packageFile('classes/MyClass.cls-meta.xml')).to.contain('61.0');
  });

  it('uses sourceApiVersion from sfdx-project.json in the manifests', async () => {
    await writeFile(path.join(ctx.repo.root, 'sfdx-project.json'), JSON.stringify({ sourceApiVersion: '62.0' }), 'utf8');
    await ctx.repo.baseline({ 'classes/MyClass.cls': 'public class MyClass {}\n' });
    await ctx.repo.write({ 'classes/MyClass.cls': 'public class MyClass { }\n' });

    const delta = await ctx.repo.delta();

    expect(await readFile(delta.result.packageManifestPath, 'utf8')).to.contain('<version>62.0</version>');
  });

  const lwcBundle = {
    'lwc/myCmp/myCmp.js': 'export default class MyCmp {}\n',
    'lwc/myCmp/myCmp.html': '<template></template>\n',
    'lwc/myCmp/myCmp.css': '.title { color: red; }\n',
    'lwc/myCmp/myCmp.js-meta.xml': `${XML_HEADER}<LightningComponentBundle ${NS}><apiVersion>61.0</apiVersion></LightningComponentBundle>\n`,
  };

  it('redeploys an LWC bundle when only one of its files is deleted', async () => {
    await ctx.repo.baseline(lwcBundle);
    await ctx.repo.remove('lwc/myCmp/myCmp.css');

    const delta = await ctx.repo.delta();

    expect(delta.packageFiles).to.include('lwc/myCmp/myCmp.js');
    expect(delta.packageFiles).not.to.include('lwc/myCmp/myCmp.css');
    expect(await readFile(delta.result.packageManifestPath, 'utf8')).to.contain('<members>myCmp</members>');
    expect(await exists(delta.result.destructiveManifestPath!)).to.equal(false);
  });

  it('deletes an LWC bundle when the whole bundle is removed', async () => {
    await ctx.repo.baseline(lwcBundle);
    await ctx.repo.remove('lwc/myCmp');

    const delta = await ctx.repo.delta();

    expect(await readFile(delta.result.destructiveManifestPath!, 'utf8')).to.contain('<members>myCmp</members>');
    expect(await readFile(delta.result.packageManifestPath, 'utf8')).not.to.contain('<members>myCmp</members>');
  });

  it('redeploys a folder static resource when one of its files is deleted', async () => {
    await ctx.repo.baseline({
      'staticresources/assets.resource-meta.xml': `${XML_HEADER}<StaticResource ${NS}><cacheControl>Private</cacheControl><contentType>application/zip</contentType></StaticResource>\n`,
      'staticresources/assets/css/app.css': 'body { color: red; }\n',
      'staticresources/assets/js/app.js': 'console.log(1);\n',
    });
    await ctx.repo.remove('staticresources/assets/css/app.css');

    const delta = await ctx.repo.delta();

    expect(delta.packageFiles).to.include('staticresources/assets/js/app.js');
    expect(await readFile(delta.result.packageManifestPath, 'utf8')).to.contain('<members>assets</members>');
    expect(await exists(delta.result.destructiveManifestPath!)).to.equal(false);
  });

  it('handles a from ref where the source directory does not exist yet', async () => {
    await writeFile(path.join(ctx.repo.root, 'README.md'), 'empty project\n', 'utf8');
    ctx.repo.commit('base');
    await ctx.repo.write({ 'classes/MyClass.cls': 'public class MyClass {}\n' });

    const delta = await ctx.repo.delta();

    expect(delta.packageFiles).to.include('classes/MyClass.cls');
    expect(await readFile(delta.result.packageManifestPath, 'utf8')).to.contain('<members>MyClass</members>');
  });
});

// Rename detection is git's own (it pairs files by content, `git diff -M`): this needs a real repository.
describe('mdt:git:delta parity, rename detection by git', () => {
  const ctx = useDeltaRepo({ git: true });

  it('turns a rename into a destructive entry plus a package entry', async () => {
    await ctx.repo.baseline({
      'classes/OldName.cls': 'public class OldName { /* long enough body to be detected as a rename */ }\n',
      'classes/OldName.cls-meta.xml': `${XML_HEADER}<ApexClass ${NS}><apiVersion>61.0</apiVersion><status>Active</status></ApexClass>\n`,
    });
    ctx.repo.rename('classes/OldName.cls', 'classes/NewName.cls');
    ctx.repo.rename('classes/OldName.cls-meta.xml', 'classes/NewName.cls-meta.xml');

    const delta = await ctx.repo.delta();
    const destructiveManifest = await readFile(delta.result.destructiveManifestPath!, 'utf8');

    expect(delta.packageFiles).to.include('classes/NewName.cls');
    expect(await readFile(delta.result.packageManifestPath, 'utf8')).to.contain('<members>NewName</members>');
    expect(destructiveManifest).to.contain('<members>OldName</members>');
  });
});

// Behaviours of `sfdx mdt:profile:retrieve`. mdt read the profile with jsforce readSync and re-serialised it; every
// deviation below is a bug of mdt that would corrupt the repository or hide a failure.
describe('mdt:profile:retrieve parity', () => {
  let root: string;
  const stub = `${XML_HEADER}<Profile ${NS}/>\n`;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sf-df-mdt-profile-'));
    await mkdir(path.join(root, 'profiles'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const profile = async (fileName: string): Promise<string> => {
    const filePath = path.join(root, 'profiles', fileName);
    await writeFile(filePath, stub, 'utf8');
    return filePath;
  };

  it('retrieves every profile of a folder, or a single profile file', async () => {
    const admin = await profile('Admin.profile-meta.xml');
    await profile('Standard.profile-meta.xml');
    const connection = fakeConnection({ Admin: '<custom>false</custom>', Standard: '<custom>false</custom>' });

    const folder = await retrieveProfiles({ connection, sourcePath: path.join(root, 'profiles') });
    const file = await retrieveProfiles({ connection, sourcePath: admin });

    expect(folder.profiles.map((item) => item.fullName)).to.deep.equal(['Admin', 'Standard']);
    expect(file.profiles.map((item) => item.fullName)).to.deep.equal(['Admin']);
  });

  it('deviation: a profile missing from the org leaves its file untouched (mdt wrote an empty profile over it)', async () => {
    const ghost = await profile('Ghost.profile-meta.xml');

    const result = await retrieveProfiles({ connection: fakeConnection({}), sourcePath: ghost });

    expect(result.profiles[0].status).to.equal('notFound');
    expect(await readFile(ghost, 'utf8')).to.equal(stub);
  });

  it('deviation: the name is the full file name (mdt kept the text before the first dot: "Sales v1.2" became "Sales v1")', async () => {
    const versioned = await profile('Sales v1.2.profile-meta.xml');
    const calls: string[][] = [];

    await retrieveProfiles({ connection: fakeConnection({ 'Sales v1.2': '<custom>true</custom>' }, calls), sourcePath: versioned });

    expect(calls).to.deep.equal([['Sales v1.2']]);
  });

  it('deviation: files that are not profiles are ignored (mdt read every file of the folder as a profile)', async () => {
    await profile('Admin.profile-meta.xml');
    await writeFile(path.join(root, 'profiles', 'README.md'), '# profiles\n', 'utf8');
    const calls: string[][] = [];

    await retrieveProfiles({ connection: fakeConnection({ Admin: '<custom>false</custom>' }, calls), sourcePath: path.join(root, 'profiles') });

    expect(calls).to.deep.equal([['Admin']]);
  });

  it('deviation: a failed read is reported per profile (mdt logged it and still returned success)', async () => {
    const admin = await profile('Admin.profile-meta.xml');

    const result = await retrieveProfiles({ connection: fakeConnection({ Admin: new Error('UNKNOWN_EXCEPTION') }), sourcePath: admin });

    expect(result.profiles[0]).to.include({ status: 'failed', error: 'UNKNOWN_EXCEPTION' });
  });
});
