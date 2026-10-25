import path from 'node:path';

import { Messages, SfProject } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';

import { alignFiles, type AlignResult } from '../../../align/align.js';
import { defaultApplicationOf, listOrgComponents } from '../../../align/org-components.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df.org.align');

export type OrgAlignResult = AlignResult & { dryRun: boolean };

const resolveProject = async (): Promise<SfProject | undefined> => {
  try {
    return await SfProject.resolve();
  } catch {
    return undefined;
  }
};

export default class OrgAlign extends SfCommand<OrgAlignResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    'api-version': Flags.orgApiVersion({
      char: 'a',
      summary: messages.getMessage('flags.api-version.summary'),
    }),
    'source-dir': Flags.string({
      char: 'd',
      multiple: true,
      summary: messages.getMessage('flags.source-dir.summary'),
      description: messages.getMessage('flags.source-dir.description'),
    }),
    'dry-run': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.dry-run.summary'),
    }),
  };

  public async run(): Promise<OrgAlignResult> {
    const { flags } = await this.parse(OrgAlign);
    // Without --source-dir, the project is needed: SfProject.resolve explains a missing one.
    const project = flags['source-dir'] ? await resolveProject() : await SfProject.resolve();
    const packageDirectories = project?.getPackageDirectories().map((directory) => directory.fullPath) ?? [];
    const sourcePaths = flags['source-dir']?.map((sourcePath) => path.resolve(sourcePath)) ?? packageDirectories;
    const connection = flags['target-org'].getConnection(flags['api-version']);
    const dryRun = flags['dry-run'];

    this.spinner.start(messages.getMessage('spinner.start', [flags['target-org'].getUsername()]));
    const result = await alignFiles({
      sourcePaths,
      projectPaths: [...new Set([...packageDirectories, ...sourcePaths])],
      listOrgComponents: (request) => listOrgComponents(connection, request),
      defaultApplication: (profile) => defaultApplicationOf(connection, profile),
      dryRun,
    });
    this.spinner.stop();

    this.report(result, dryRun);
    return { dryRun, ...result };
  }

  private report(result: AlignResult, dryRun: boolean): void {
    for (const { type, error } of result.unlistedTypes) {
      this.warn(messages.getMessage('warning.unlisted', [type, error]));
    }

    for (const skipped of result.skipped) {
      this.warn(messages.getMessage(`warning.${skipped.reason}`, [skipped.type, skipped.fullName]));
    }

    for (const file of result.files.filter(({ defaultApplication }) => defaultApplication !== undefined)) {
      this.log(messages.getMessage('info.defaultApplication', [file.fullName, file.defaultApplication]));
    }

    if (result.files.length === 0) {
      this.log(messages.getMessage('info.aligned'));
      return;
    }

    const cwd = process.cwd();
    this.table({
      data: result.files.flatMap((file) =>
        file.removed.map((entry) => ({
          file: path.relative(cwd, file.filePath),
          entry: entry.section,
          missing: `${entry.type}:${entry.name}`,
        }))
      ),
      columns: [
        { key: 'file', name: 'File' },
        { key: 'entry', name: 'Entry' },
        { key: 'missing', name: 'Missing from the org' },
      ],
    });

    const entries = result.files.reduce((total, file) => total + file.removed.length, 0);
    this.log(messages.getMessage(dryRun ? 'info.dryRun' : 'info.removed', [entries, result.files.length]));
  }
}
