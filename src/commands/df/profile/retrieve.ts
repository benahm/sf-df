import { Messages, SfProject } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';

import {
  findProfileSources,
  retrieveProfiles,
  type ProfileRetrieveResult,
} from '../../../retrieve/profile-retrieve.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df.profile.retrieve');

// Profile content depends on the API version: the project's sourceApiVersion is used so that the retrieved
// profile only holds what the project deploys.
const projectApiVersion = async (): Promise<string | undefined> => {
  try {
    const config = await (await SfProject.resolve()).resolveProjectConfig();
    return typeof config.sourceApiVersion === 'string' ? config.sourceApiVersion : undefined;
  } catch {
    return undefined;
  }
};

export default class ProfileRetrieve extends SfCommand<ProfileRetrieveResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
    'source-dir': Flags.string({
      char: 'd',
      required: true,
      summary: messages.getMessage('flags.source-dir.summary'),
      description: messages.getMessage('flags.source-dir.description'),
      // sfdx mdt:profile:retrieve name, kept so existing pipelines keep working.
      aliases: ['sourcepath'],
      deprecateAliases: true,
    }),
    'output-dir': Flags.directory({
      char: 'r',
      summary: messages.getMessage('flags.output-dir.summary'),
      description: messages.getMessage('flags.output-dir.description'),
      // sfdx mdt:profile:retrieve name, kept so existing pipelines keep working.
      aliases: ['outputdir'],
      deprecateAliases: true,
    }),
  };

  public async run(): Promise<ProfileRetrieveResult> {
    const { flags } = await this.parse(ProfileRetrieve);
    const sources = findProfileSources(flags['source-dir']);
    if (sources.length === 0) {
      throw messages.createError('error.noProfile', [flags['source-dir']]);
    }

    const connection = flags['target-org'].getConnection(flags['api-version'] ?? (await projectApiVersion()));
    this.spinner.start(messages.getMessage('spinner.start', [connection.getApiVersion()]));
    this.spinner.status = `0/${sources.length}`;
    const result = await retrieveProfiles({
      connection,
      sourcePath: flags['source-dir'],
      sources,
      outputDir: flags['output-dir'],
      onProgress: (_profile, done, total) => {
        this.spinner.status = `${done}/${total}`;
      },
    });

    const failed = result.profiles.filter((profile) => profile.status !== 'retrieved');
    this.spinner.stop(messages.getMessage(failed.length > 0 ? 'spinner.partial' : 'spinner.success'));
    this.table({
      data: result.profiles.map(({ fullName, status, filePath }) => ({
        fullName,
        status,
        filePath,
      })),
    });

    for (const profile of failed) {
      this.warn(
        profile.status === 'notFound'
          ? messages.getMessage('warning.notFound', [profile.fullName])
          : messages.getMessage('warning.failed', [profile.fullName, profile.error ?? ''])
      );
    }

    if (failed.length > 0) {
      process.exitCode = 1;
    }

    return result;
  }
}
