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

const looksLikeTest = (className: string): boolean => /test/i.test(className);

// Naming convention: a deployed class is covered by `<Class>Test` or `<Class>_Test`, and a deployed test class runs
// itself. Only classes that exist in the deployed tree are kept, so a convention miss never fails the deployment.
export const selectTests = (deployedClasses: Iterable<string>, existingClasses: Iterable<string>): string[] => {
  const existing = new Map([...existingClasses].map((name) => [name.toLowerCase(), name]));
  const selected = new Set<string>();

  for (const className of deployedClasses) {
    const candidates = looksLikeTest(className) ? [className] : [`${className}Test`, `${className}_Test`];
    for (const candidate of candidates) {
      const match = existing.get(candidate.toLowerCase());
      if (match) {
        selected.add(match);
      }
    }
  }

  return [...selected].sort();
};

// Without --test-level: the tests of the deployed classes, or none when no test matches (sandboxes don't require any).
export const planTests = (
  deployedClasses: Iterable<string>,
  existingClasses: Iterable<string>,
  requested?: TestLevel
): TestPlan => {
  if (requested && requested !== 'RunSpecifiedTests') {
    return { testLevel: requested, tests: [] };
  }

  const tests = selectTests(deployedClasses, existingClasses);
  if (tests.length > 0) {
    return { testLevel: 'RunSpecifiedTests', tests };
  }

  if (requested === 'RunSpecifiedTests') {
    throw new Error('--test-level RunSpecifiedTests: no test class matches the Apex classes of the delta.');
  }

  return { testLevel: 'NoTestRun', tests: [] };
};
