import path from 'node:path';

export type TestLevel = 'NoTestRun' | 'RunSpecifiedTests' | 'RunLocalTests' | 'RunAllTestsInOrg';

export type TestPlan = {
  testLevel: TestLevel;
  tests: string[];
};

const CLASS_SUFFIX = '.cls';

export const apexClassName = (filePath: string): string | undefined => {
  const base = path.posix.basename(filePath.replaceAll('\\', '/'));
  return base.endsWith(CLASS_SUFFIX) ? base.slice(0, -CLASS_SUFFIX.length) : undefined;
};

// Naming convention: a deployed class or trigger is covered by `<Name>Test` or `<Name>_Test`, and a deployed test
// class runs itself. `testClasses` are the classes of the deployed tree that are really tests (@isTest), never
// guessed from their name: `LatestService` or `Contest` are not tests. Only those are kept, so a convention miss
// never fails the deployment.
export const selectTests = (deployedApex: Iterable<string>, testClasses: Iterable<string>): string[] => {
  const tests = new Map([...testClasses].map((name) => [name.toLowerCase(), name]));
  const selected = new Set<string>();

  for (const name of deployedApex) {
    for (const candidate of [name, `${name}Test`, `${name}_Test`]) {
      const match = tests.get(candidate.toLowerCase());
      if (match) {
        selected.add(match);
      }
    }
  }

  return [...selected].sort();
};

// Without --test-level: the tests of the deployed classes and triggers, or none when no test matches (sandboxes
// don't require any).
export const planTests = (
  deployedApex: Iterable<string>,
  testClasses: Iterable<string>,
  requested?: TestLevel
): TestPlan => {
  if (requested && requested !== 'RunSpecifiedTests') {
    return { testLevel: requested, tests: [] };
  }

  const tests = selectTests(deployedApex, testClasses);
  if (tests.length > 0) {
    return { testLevel: 'RunSpecifiedTests', tests };
  }

  if (requested === 'RunSpecifiedTests') {
    throw new Error('--test-level RunSpecifiedTests: no test class matches the Apex classes of the delta.');
  }

  return { testLevel: 'NoTestRun', tests: [] };
};
