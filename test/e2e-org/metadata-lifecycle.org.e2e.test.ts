import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, afterAll } from 'vitest';

import { generateDelta } from '../../src/delta/engine.js';
import { buildManifestXml } from '../../src/delta/manifest.js';
import type { DeltaResult } from '../../src/delta/types.js';
import { SOURCE_DIR, createLifecycleRepo, lifecycleNames } from './metadata-lifecycle.fixture.js';
import { componentsInSource, deployDelta, readAll, retrieveFromOrg, runSf } from './org-state.js';

// Replays on a real org the lifecycle that was used to harden `sf df git delta`: add the most common metadata
// types, modify / partially delete / rename them, revoke permission set accesses, then delete everything.
// Every delta is deployed in one transaction (package.xml + post-destructive changes) and the org is then
// retrieved to check it matches the repository.
//
//   RUN_E2E_ORG=true E2E_TARGET_ORG=<sandbox alias> npm run test:e2e:org
//
// The org needs the translation workbench with E2E_ORG_LANGUAGE (default: fr) enabled. Only SfDfQa* components
// are created; the test deletes them at the end. Deleted objects stay in the org recycle bin for 15 days.

const targetOrg = process.env.E2E_TARGET_ORG;
const language = process.env.E2E_ORG_LANGUAGE ?? 'fr';
const enabled = process.env.RUN_E2E_ORG === 'true' && Boolean(targetOrg);

// Checked through file contents only: a language and the label container always exist in the org.
const NOT_CHECKED_FOR_EXISTENCE = new Set(['Translations', 'CustomObjectTranslation', 'CustomLabels']);

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
      phases = createLifecycleRepo(repoRoot, names, language);
      phases.init();

      await runPhase('p1');

      const p2 = await runPhase('p2');
      expect(p2.delta.warnings.join('\n')).toContain(`RecordType:${names.obj}.RT2 cannot be deleted`);
      expect(p2.delta.warnings.join('\n')).toContain(`Flow:${names.flow2} cannot be deleted by name`);
      const retrieved = expectOrgToMatch(p2.expected, [`RecordType:${names.obj}.RT2`, `Flow:${names.flow2}`]);
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

      const p3 = await runPhase('p3');
      expect(p3.delta.warnings.join('\n')).toContain(`Translations:${language} is never deleted`);
      expectOrgToMatch(new Set(), [`Flow:${names.flow}`, `Flow:${names.flow2}`]);
    },
    60 * 60 * 1000
  );
});
