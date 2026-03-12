import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import Df from '../../src/commands/df.js';

describe('df', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;

  beforeEach(() => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    $$.restore();
  });

  it('runs df', async () => {
    await Df.run([]);
    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    expect(output).to.include('Deltaforce command for Deltaforce');
  });

  it('runs df with --json and no provided name', async () => {
    const result = await Df.run([]);
    expect(result.name).to.equal('Deltaforce');
  });

  it('runs df --name team', async () => {
    await Df.run(['--name', 'team']);
    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    expect(output).to.include('Deltaforce command for team');
  });

  it('runs df --name team --json', async () => {
    const result = await Df.run(['--name', 'team', '--json']);
    expect(result.name).to.equal('team');
  });
});
