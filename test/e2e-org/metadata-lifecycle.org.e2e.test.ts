import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, afterAll } from 'vitest';

import { generateDelta } from '../../src/delta/engine.js';
import { buildManifestXml } from '../../src/delta/manifest.js';
import type { DeltaResult } from '../../src/delta/types.js';
import { SOURCE_DIR, createLifecycleRepo, lifecycleNames } from './metadata-lifecycle.fixture.js';
import { componentsInSource, deployDelta, isScratchOrg, readAll, retrieveFromOrg, runSf } from './org-state.js';

// Replays on a real org the lifecycle that was used to harden `sf df git delta`: add the most common metadata
// types, modify / partially delete / rename them, revoke permission set accesses, then delete everything.
// Every delta is deployed in one transaction (package.xml + post-destructive changes) and the org is then
// retrieved to check it matches the repository.
//
//   RUN_E2E_ORG=true E2E_TARGET_ORG=<sandbox alias> npm run test:e2e:org
//
// The org needs the translation workbench with E2E_ORG_LANGUAGE (default: fr) enabled. Only SfDfQa* components
// are created; the test deletes them at the end. Deleted objects stay in the org recycle bin for 15 days.
// On a scratch org only, it also adds a business process to Opportunity and a value to the LeadSource standard value
// set: the API cannot delete a standard value set, so a sandbox would keep the value.

const targetOrg = process.env.E2E_TARGET_ORG;
const language = process.env.E2E_ORG_LANGUAGE ?? 'fr';
const enabled = process.env.RUN_E2E_ORG === 'true' && Boolean(targetOrg);

// Checked through file contents only: a language, the label container and a standard value set always exist.
const NOT_CHECKED_FOR_EXISTENCE = new Set(['Translations', 'CustomObjectTranslation', 'CustomLabels', 'StandardValueSet']);

describe.skipIf(!enabled)('e2e org: metadata lifecycle', () => {
  const names = lifecycleNames(Date.now().toString(36).slice(-5));
  const everDeployed = new Set<string>();
  let repoRoot: string;
  let phases: ReturnType<typeof createLifecycleRepo>;

  const runPhase = async (phase: 'p1' | 'p2' | 'p2b' | 'p3'): Promise<{ delta: DeltaResult; expected: Set<string> }> => {
    phases[phase]();
    const expected = componentsInSource(path.join(repoRoot, 'force-app'));
    expected.forEach((entry) => everDeployed.add(entry));

    const outputDir = path.join(repoRoot, `out-${phase}`);
    const delta = await generateDelta({ repoRoot, from: 'HEAD~1', to: 'HEAD', sourceDir: SOURCE_DIR, deployDir: path.join(outputDir, 'package'), destructiveDir: path.join(outputDir, 'destructive') });
    const deploy = deployDelta(outputDir, repoRoot, targetOrg!);
    expect(deploy, `${phase} deployment: ${deploy.errorMessage ?? ''} ${deploy.failures.join(' | ')}`).toMatchObject({
      status: 0,
      failures: [],
    });
    return { delta, expected };
  };

  const expectOrgToMatch = (expected: Set<string>, keptOnPurpose: string[]): string => {
    const { present, dir } = retrieveFromOrg(everDeployed, targetOrg!);
    const mismatches = [...everDeployed]
      .filter((entry) => !NOT_CHECKED_FOR_EXISTENCE.has(entry.split(':')[0]) && !keptOnPurpose.includes(entry))
      .filter((entry) => expected.has(entry) !== present.has(entry))
      .map((entry) => `${entry} ${expected.has(entry) ? 'missing from' : 'still in'} the org`);
    expect(mismatches).toEqual([]);
    return dir;
  };

  afterAll(async () => {
    if (!repoRoot) {
      return;
    }

    // Flows can only be deleted by version; the delta deactivated them.
    await writeFile(path.join(repoRoot, 'cleanup-destructive.xml'), await buildManifestXml([
      { type: 'Flow', fullName: `${names.flow}-1` },
      { type: 'Flow', fullName: `${names.flow2}-1` },
    ]));
    await writeFile(path.join(repoRoot, 'cleanup-package.xml'), await buildManifestXml([]));
    runSf(
      [
        'project', 'deploy', 'start', '-x', path.join(repoRoot, 'cleanup-package.xml'),
        '--post-destructive-changes', path.join(repoRoot, 'cleanup-destructive.xml'),
        '-o', targetOrg!, '-w', '30', '--json',
      ],
      repoRoot
    );
    await rm(repoRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it(
    'deploys every delta of the lifecycle and leaves the org matching the repository',
    async () => {
      repoRoot = await mkdtemp(path.join(tmpdir(), 'sf-df-e2e-lifecycle-'));
      const standard = isScratchOrg(targetOrg!)
        ? { leadSourceXml: readAll(retrieveFromOrg(['StandardValueSet:LeadSource'], targetOrg!).dir, /standardValueSets\//) }
        : undefined;
      phases = createLifecycleRepo(repoRoot, names, language, standard);
      phases.init();

      await runPhase('p1');

      const p2 = await runPhase('p2');
      expect(p2.delta.warnings.join('\n')).toContain(`RecordType:${names.obj}.RT2 cannot be deleted`);
      expect(p2.delta.warnings.join('\n')).toContain(`Flow:${names.flow2} cannot be deleted by name`);
      expect(p2.delta.warnings.join('\n')).toContain(
        `1 item(s) removed from Profile:SfDfQa_Profile stay in the org: fieldPermissions ${names.obj}.F3__c`
      );
      const retrieved = expectOrgToMatch(p2.expected, [`RecordType:${names.obj}.RT2`, `Flow:${names.flow2}`]);
      // The profile delta is partial: only F1 and the new class ship, the rest of the profile stays as it was.
      const profile = readAll(retrieved, /profiles\//).replaceAll(/\s/g, '');
      expect(profile).toContain(`<editable>false</editable><field>${names.obj}.F1__c</field>`);
      expect(profile).toContain(`<editable>true</editable><field>${names.obj}.F3__c</field>`);
      expect(profile).toContain('<apexClass>SfDfQaA</apexClass><enabled>true</enabled>');
      expect(profile).toContain('<apexClass>SfDfQaD</apexClass><enabled>true</enabled>');
      expect(profile).toContain(`<layout>${names.obj}-SfDfQaLayout</layout>`);
      const valueSet = readAll(retrieved, /globalValueSets\//);
      expect(valueSet).toContain('<fullName>Z</fullName>');
      // A value removed from the file is deactivated, not deleted.
      expect(valueSet.replaceAll(/\s/g, '')).toContain('<fullName>Y</fullName><default>false</default><isActive>false</isActive>');
      const markers: Array<[RegExp, string, boolean?]> = [
        [/recordTypes\/RT2\./, '<active>false</active>'],
        [/recordTypes\/RT1\./, 'RT1 v2'],
        [/fields\/F1__c\./, 'F1 v2'],
        [/validationRules\/VR1\./, 'Too long v2'],
        [/classes\/SfDfQaA\.cls$/, 'v2'],
        [/lwc\/sfDfQaCmp\/sfDfQaCmp\.html$/, 'QA v2'],
        [/labels\//, 'One v2'],
        [/labels\//, 'SfDfQa_L4'],
        [/customMetadata\/.*Rec1/, 'one v2'],
        [/permissionsets\//, 'SfDfQa_Perm2'],
        [/sharingRules\//, '<accessLevel>Edit</accessLevel>'],
        [/workflows\//, '&quot;v2&quot;'],
        [/email\/.*Tpl1\.email$/, 'Hello v2'],
        [/flexipages\//, 'QA v2'],
        [/permissionsetgroups\//, 'SfDfQa_PS2'],
        [/mutingpermissionsets\//, `<field>${names.obj}.F1__c</field>`],
        [/layouts\//, 'F2__c', false],
        [/objectTranslations\//, 'Champ 1 v2'],
        // Not in the p2 delta: deploying an object translation keeps the field translations it does not carry.
        [/objectTranslations\//, 'Champ 3'],
      ];
      for (const [file, text, shouldContain = true] of markers) {
        expect(readAll(retrieved, file).includes(text), `${file} ${shouldContain ? 'contains' : 'lacks'} ${text}`).toBe(
          shouldContain
        );
      }

      await runPhase('p2b');
      const permissionSet = readAll(retrieveFromOrg(['PermissionSet:SfDfQa_PS'], targetOrg!).dir, /permissionsets\//);
      expect(permissionSet).toContain('SfDfQaD');
      expect(permissionSet).not.toContain('SfDfQaA');
      expect(permissionSet).not.toContain('SfDfQa_Perm2');

      if (standard) {
        const standardObjects = readAll(
          retrieveFromOrg(['BusinessProcess:Opportunity.SfDfQa_BP', 'StandardValueSet:LeadSource'], targetOrg!).dir,
          /./
        );
        expect(standardObjects).toContain('<fullName>Qualification</fullName>');
        expect(standardObjects).toContain('SfDfQa Source v2');
      }

      const p3 = await runPhase('p3');
      expect(p3.delta.warnings.join('\n')).toContain(`Translations:${language} is never deleted`);
      if (standard) {
        expect(p3.delta.warnings.join('\n')).toContain('StandardValueSet:LeadSource cannot be deleted');
      }
      expectOrgToMatch(new Set(), [`Flow:${names.flow}`, `Flow:${names.flow2}`]);
    },
    60 * 60 * 1000
  );
});
