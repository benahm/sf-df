import { expect } from 'chai';

import { findOrgConfig, normalizeOrgUrl, parseDeployConfig } from '../../src/deploy/config.js';
import { planTests, selectTests } from '../../src/deploy/tests.js';

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

  it('runs no test when none matches, unless a level is requested', () => {
    expect(planTests(['Report'], testClasses)).to.deep.equal({ testLevel: 'NoTestRun', tests: [] });
    expect(planTests(['Report'], testClasses, 'RunLocalTests')).to.deep.equal({
      testLevel: 'RunLocalTests',
      tests: [],
    });
    expect(() => planTests(['Report'], testClasses, 'RunSpecifiedTests')).to.throw('no test class matches');
  });
});
