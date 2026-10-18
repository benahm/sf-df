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
  const existing = ['Invoice', 'InvoiceTest', 'Order', 'Order_Test', 'Report', 'TestDataFactory'];

  it('runs the tests named after the deployed classes, and the deployed test classes', () => {
    expect(selectTests(['Invoice', 'Order', 'Report', 'TestDataFactory'], existing)).to.deep.equal([
      'InvoiceTest',
      'Order_Test',
      'TestDataFactory',
    ]);
  });

  it('runs no test when none matches, unless a level is requested', () => {
    expect(planTests(['Report'], existing)).to.deep.equal({ testLevel: 'NoTestRun', tests: [] });
    expect(planTests(['Report'], existing, 'RunLocalTests')).to.deep.equal({
      testLevel: 'RunLocalTests',
      tests: [],
    });
    expect(() => planTests(['Report'], existing, 'RunSpecifiedTests')).to.throw('no test class matches');
  });
});
