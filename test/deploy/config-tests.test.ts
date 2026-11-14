import { expect } from 'chai';

import { findOrgConfig, normalizeOrgUrl, parseDeployConfig } from '../../src/deploy/config.js';
import {
  parseTestAnnotations,
  planSpecifiedTests,
  planTests,
  selectTests,
  untestedApex,
} from '../../src/deploy/tests.js';

describe('deploy configuration', () => {
  const project = (sfdf: unknown): unknown => ({
    packageDirectories: [{ path: 'force-app' }],
    plugins: { sfdf },
  });

  it('reads the branch of each org, with defaults for the remote and the source folder', () => {
    const config = parseDeployConfig(
      project({ orgs: [{ url: 'https://example--int.sandbox.my.salesforce.com', branch: 'int' }] })
    );

    expect(config).to.deep.equal({
      orgs: [{ url: 'https://example--int.sandbox.my.salesforce.com', branch: 'int' }],
      remote: 'origin',
      sourceDir: 'force-app/main/default',
    });
  });

  it('identifies an org by its URL, whatever the protocol, case or trailing slash', () => {
    const config = parseDeployConfig(
      project({
        orgs: [{ url: 'https://Example--INT.sandbox.my.salesforce.com/', branch: 'int' }],
      })
    );

    expect(normalizeOrgUrl('HTTPS://example--int.sandbox.my.salesforce.com')).to.equal(
      'example--int.sandbox.my.salesforce.com'
    );
    expect(findOrgConfig(config, 'https://example--int.sandbox.my.salesforce.com')?.branch).to.equal('int');
    expect(findOrgConfig(config, 'https://example--uat.sandbox.my.salesforce.com')).to.equal(undefined);
  });

  it('rejects a missing configuration, a duplicate org and a branch shared by two orgs', () => {
    expect(() => parseDeployConfig({ packageDirectories: [] })).to.throw('missing');
    expect(() =>
      parseDeployConfig(
        project({
          orgs: [
            { url: 'https://a.my.salesforce.com', branch: 'int' },
            { url: 'https://A.my.salesforce.com/', branch: 'uat' },
          ],
        })
      )
    ).to.throw('declared twice');
    expect(() =>
      parseDeployConfig(
        project({
          orgs: [
            { url: 'https://a.my.salesforce.com', branch: 'int' },
            { url: 'https://b.my.salesforce.com', branch: 'int' },
          ],
        })
      )
    ).to.throw('linked to several orgs');
  });
});

describe('deploy test selection', () => {
  // The classes annotated @isTest, whatever their name.
  const testClasses = ['InvoiceTest', 'Order_Test', 'TestDataFactory', 'LatestServiceTest', 'InvoiceTriggerTest'];

  it('runs the tests named after the deployed classes, and the deployed test classes', () => {
    expect(selectTests(['Invoice', 'Order', 'Report', 'TestDataFactory'], testClasses)).to.deep.equal([
      'InvoiceTest',
      'Order_Test',
      'TestDataFactory',
    ]);
  });

  it('does not take a class for a test because its name contains "test"', () => {
    expect(selectTests(['LatestService', 'Contest'], testClasses)).to.deep.equal(['LatestServiceTest']);
  });

  it('runs the test named after a deployed trigger', () => {
    expect(selectTests(['InvoiceTrigger'], testClasses)).to.deep.equal(['InvoiceTriggerTest']);
  });

  it('runs the tests that mention a deployed class, whatever their name', () => {
    // InvoiceChecks is a test class that uses Report; Helper is not a test class.
    const references = new Map([['report', ['InvoiceChecks', 'Helper']]]);
    const classes = [...testClasses, 'InvoiceChecks'];

    expect(selectTests(['Report', 'Invoice'], classes, references)).to.deep.equal(['InvoiceChecks', 'InvoiceTest']);
    expect(planTests(['Report'], classes, undefined, references)).to.deep.equal({
      testLevel: 'RunSpecifiedTests',
      tests: ['InvoiceChecks'],
    });
  });

  it('lists the deployed classes no test was found for', () => {
    const references = new Map([['report', ['TestDataFactory']]]);

    expect(untestedApex(['Report', 'Invoice', 'Orphan', 'TestDataFactory'], testClasses, references)).to.deep.equal([
      'Orphan',
    ]);
  });

  it('runs no test when none matches, unless a level is requested', () => {
    expect(planTests(['Report'], testClasses)).to.deep.equal({ testLevel: 'NoTestRun', tests: [] });
    expect(planTests(['Report'], testClasses, 'RunLocalTests')).to.deep.equal({
      testLevel: 'RunLocalTests',
      tests: [],
    });
    expect(() => planTests(['Report'], testClasses, 'RunSpecifiedTests')).to.throw('no test class matches');
  });

  it('reads testFor and critical on the class-level @IsTest, as RunRelevantTests does', () => {
    const source = [
      "// @IsTest(testFor='ApexClass:Commented')",
      '/* @IsTest(critical=true) */',
      "@IsTest(testFor = 'ApexClass:Invoice, ApexTrigger:InvoiceTrigger ,' critical=true)",
      'private class InvoiceChecks {',
      "  @IsTest(testFor='ApexClass:Method') static void run() { String s = '// not a comment'; }",
      '}',
    ].join('\n');

    expect(parseTestAnnotations(source)).to.deep.equal({
      testFor: ['ApexClass:Invoice', 'ApexTrigger:InvoiceTrigger'],
      critical: true,
    });
    expect(parseTestAnnotations('@isTest\nprivate class Plain {}')).to.deep.equal({
      testFor: [],
      critical: false,
    });
    expect(parseTestAnnotations('@IsTest(critical=false)\nprivate class NotCritical {}').critical).to.equal(false);
  });

  it('adds the critical tests whenever Apex is deployed, and only then', () => {
    expect(planTests(['Report'], testClasses, undefined, undefined, ['TestDataFactory'])).to.deep.equal({
      testLevel: 'RunSpecifiedTests',
      tests: ['TestDataFactory'],
    });
    expect(planTests([], testClasses, undefined, undefined, ['TestDataFactory'])).to.deep.equal({
      testLevel: 'NoTestRun',
      tests: [],
    });
  });

  it('uses the explicit test list with RunSpecifiedTests', () => {
    const expected = { testLevel: 'RunSpecifiedTests', tests: ['OrderTest', 'InvoiceTest'] };
    expect(planSpecifiedTests([' OrderTest ', 'InvoiceTest', 'OrderTest'])).to.deep.equal(expected);
    expect(planSpecifiedTests(['OrderTest', 'InvoiceTest'], 'RunSpecifiedTests')).to.deep.equal(expected);
  });

  it('rejects empty test names and incompatible test levels', () => {
    expect(() => planSpecifiedTests([])).to.throw('non-empty Apex test names');
    expect(() => planSpecifiedTests([' '])).to.throw('non-empty Apex test names');
    expect(() => planSpecifiedTests(['OrderTest'], 'RunLocalTests')).to.throw(
      'requires --test-level RunSpecifiedTests'
    );
  });
});
