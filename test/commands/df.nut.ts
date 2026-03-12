import { execCmd, TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { DfResult } from '../../src/commands/df.js';

let testSession: TestSession;

describe('df NUTs', () => {
  before('prepare session', async () => {
    testSession = await TestSession.create();
  });

  after(async () => {
    await testSession?.clean();
  });

  it('should run sf df', () => {
    const result = execCmd<DfResult>('df --json', { ensureExitCode: 0 }).jsonOutput?.result;
    expect(result?.name).to.equal('Deltaforce');
  });

  it('should run sf df with a given name', () => {
    const result = execCmd<DfResult>('df --name team --json', {
      ensureExitCode: 0,
    }).jsonOutput?.result;
    expect(result?.name).to.equal('team');
  });
});
