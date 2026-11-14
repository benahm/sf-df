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

// The parameters of the class-level @IsTest annotation that RunRelevantTests reads (API 66.0):
// - `testFor`: the components the test class covers, "ApexClass:Name" or "ApexTrigger:Name";
// - `critical`: the test class runs whenever Apex is deployed.
export type TestAnnotations = { testFor: string[]; critical: boolean };

// Removes the comments, keeps the strings: `testFor` is a string, and a commented-out annotation must not count.
const stripComments = (source: string): string => {
  let result = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      result += ' ';
    } else if (char === "'") {
      let end = index + 1;
      while (end < source.length && source[end] !== "'") {
        end += source[end] === '\\' ? 2 : 1;
      }

      result += source.slice(index, end + 1);
      index = end + 1;
    } else {
      result += char;
      index += 1;
    }
  }

  return result;
};

// Reads the @IsTest annotations of the class declaration: everything before the first "{". The annotations of the
// methods, inside the class body, are ignored, as Salesforce only reads `testFor` and `critical` on the class.
export const parseTestAnnotations = (source: string): TestAnnotations => {
  const code = stripComments(source);
  const brace = code.indexOf('{');
  const header = brace === -1 ? code : code.slice(0, brace);
  const result: TestAnnotations = { testFor: [], critical: false };

  for (const [, parameters] of header.matchAll(/@istest\s*\(([^)]*)\)/gi)) {
    const testFor = /\btestfor\s*=\s*'([^']*)'/i.exec(parameters);
    if (testFor) {
      result.testFor.push(
        ...testFor[1]
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      );
    }

    if (/\bcritical\s*=\s*true\b/i.test(parameters)) {
      result.critical = true;
    }
  }

  return result;
};

// The test classes that mention a class, by lowercased class name.
export type TestReferences = ReadonlyMap<string, readonly string[]>;

const NO_REFERENCES: TestReferences = new Map();

// The tests of each deployed class or trigger:
// - a deployed test class runs itself;
// - the naming convention: `<Name>Test` or `<Name>_Test`;
// - `references`: the test classes that mention the class, whatever their name, or declare it in
//   @IsTest(testFor=...).
// `testClasses` are the classes of the deployed tree that are really tests (@isTest), never guessed from their
// name: `LatestService` or `Contest` are not tests. Only those are kept, so a convention miss never fails the
// deployment.
export const testsByClass = (
  deployedApex: Iterable<string>,
  testClasses: Iterable<string>,
  references: TestReferences = NO_REFERENCES
): Map<string, string[]> => {
  const tests = new Map([...testClasses].map((name) => [name.toLowerCase(), name]));
  const byClass = new Map<string, string[]>();

  for (const name of deployedApex) {
    const candidates = [name, `${name}Test`, `${name}_Test`, ...(references.get(name.toLowerCase()) ?? [])];
    const matches = candidates.flatMap((candidate) => tests.get(candidate.toLowerCase()) ?? []);
    byClass.set(name, [...new Set(matches)]);
  }

  return byClass;
};

export const selectTests = (
  deployedApex: Iterable<string>,
  testClasses: Iterable<string>,
  references: TestReferences = NO_REFERENCES
): string[] => [...new Set([...testsByClass(deployedApex, testClasses, references).values()].flat())].sort();

// The deployed classes and triggers no test was found for.
export const untestedApex = (
  deployedApex: Iterable<string>,
  testClasses: Iterable<string>,
  references: TestReferences = NO_REFERENCES
): string[] =>
  [...testsByClass(deployedApex, testClasses, references)]
    .filter(([, tests]) => tests.length === 0)
    .map(([name]) => name)
    .sort();

export const planSpecifiedTests = (names: readonly string[], requested?: TestLevel): TestPlan => {
  if (requested && requested !== 'RunSpecifiedTests') {
    throw new Error('--tests requires --test-level RunSpecifiedTests when a test level is supplied.');
  }

  const tests = names.map((name) => name.trim());
  if (tests.length === 0 || tests.includes('')) {
    throw new Error('--tests requires one or more non-empty Apex test names.');
  }

  return { testLevel: 'RunSpecifiedTests', tests: [...new Set(tests)] };
};

// Without --test-level: the tests of the deployed classes and triggers, plus the critical tests when Apex is
// deployed, or none when no test matches (sandboxes don't require any).
export const planTests = (
  deployedApex: Iterable<string>,
  testClasses: Iterable<string>,
  requested?: TestLevel,
  references: TestReferences = NO_REFERENCES,
  critical: Iterable<string> = []
): TestPlan => {
  if (requested && requested !== 'RunSpecifiedTests') {
    return { testLevel: requested, tests: [] };
  }

  const deployed = [...deployedApex];
  const tests = [
    ...new Set([...selectTests(deployed, testClasses, references), ...(deployed.length > 0 ? critical : [])]),
  ].sort();
  if (tests.length > 0) {
    return { testLevel: 'RunSpecifiedTests', tests };
  }

  if (requested === 'RunSpecifiedTests') {
    throw new Error('--test-level RunSpecifiedTests: no test class matches the Apex classes of the delta.');
  }

  return { testLevel: 'NoTestRun', tests: [] };
};
