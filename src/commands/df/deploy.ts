import { Messages } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';

import { readSourceApiVersion } from '../../delta/manifest.js';
import { readDeployConfig } from '../../deploy/config.js';
import { deployBranch, type DeployBranchResult } from '../../deploy/deploy.js';
import { gitRoot } from '../../deploy/git.js';
import { metadataApiDeployer } from '../../deploy/salesforce.js';
import type { TestLevel } from '../../deploy/tests.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df.deploy');

const TEST_LEVELS: TestLevel[] = ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'];

export default class Deploy extends SfCommand<DeployBranchResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    source: Flags.string({
      char: 's',
      required: true,
      summary: messages.getMessage('flags.source.summary'),
      description: messages.getMessage('flags.source.description'),
    }),
    'target-org': Flags.requiredOrg(),
    'dry-run': Flags.boolean({
      summary: messages.getMessage('flags.dry-run.summary'),
      exclusive: ['validate'],
    }),
    validate: Flags.boolean({
      summary: messages.getMessage('flags.validate.summary'),
      description: messages.getMessage('flags.validate.description'),
    }),
    from: Flags.string({
      summary: messages.getMessage('flags.from.summary'),
      description: messages.getMessage('flags.from.description'),
    }),
    'allow-destructive': Flags.boolean({
      summary: messages.getMessage('flags.allow-destructive.summary'),
    }),
    'test-level': Flags.string({
      char: 'l',
      options: TEST_LEVELS,
      summary: messages.getMessage('flags.test-level.summary'),
      description: messages.getMessage('flags.test-level.description'),
    }),
    wait: Flags.duration({
      char: 'w',
      unit: 'minutes',
      defaultValue: 60,
      min: 1,
      summary: messages.getMessage('flags.wait.summary'),
    }),
  };

  public async run(): Promise<DeployBranchResult> {
    const { flags } = await this.parse(Deploy);
    const repoRoot = await gitRoot(process.cwd());
    const config = await readDeployConfig(repoRoot);
    // The project's sourceApiVersion, as `sf project deploy start` does.
    const connection = flags['target-org'].getConnection(await readSourceApiVersion(repoRoot));

    this.spinner.start(messages.getMessage('spinner.start'));
    let result: DeployBranchResult;
    try {
      result = await deployBranch({
        repoRoot,
        config,
        orgUrl: connection.instanceUrl,
        source: flags.source,
        from: flags.from,
        dryRun: flags['dry-run'],
        validate: flags.validate,
        allowDestructive: flags['allow-destructive'],
        testLevel: flags['test-level'] as TestLevel | undefined,
        wait: flags.wait,
        deployer: metadataApiDeployer(connection),
        progress: (step) => {
          this.spinner.status = step;
        },
      });
    } catch (error) {
      this.spinner.stop(messages.getMessage('spinner.error'));
      throw error;
    }

    this.spinner.stop(messages.getMessage(`status.${result.status}`, [result.branch]));
    this.log(messages.getMessage('info.merge', [result.source, result.branch, result.commit.slice(0, 7)]));
    this.log(messages.getMessage('info.delta', [String(result.components.length), String(result.deletions.length)]));
    if (result.components.length + result.deletions.length > 0) {
      this.log(messages.getMessage('info.tests', [result.testLevel, result.tests.join(', ') || '-']));
    }

    if (result.deployId) {
      this.log(messages.getMessage('info.job', [result.deployId]));
    }

    if (result.deletions.length > 0 && result.status === 'dryRun') {
      this.log(messages.getMessage('info.deletions', [result.deletions.join('\n  ')]));
    }

    for (const warning of result.warnings) {
      this.warn(warning);
    }

    return result;
  }
}
