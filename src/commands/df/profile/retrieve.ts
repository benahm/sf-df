import path from 'node:path';

import { type Connection, Messages, SfProject } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';

import {
  findProfileSources,
  retrieveProfiles,
  type ProfileRetrieveResult,
  type ProfileSource,
} from '../../../retrieve/profile-retrieve.js';
import {
  listOrgProfiles,
  profileNameOfEntry,
  profileNamesOfManifest,
  selectProfiles,
} from '../../../retrieve/profile-selection.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df.profile.retrieve');

const resolveProject = async (): Promise<SfProject | undefined> => {
  try {
    return await SfProject.resolve();
  } catch {
    return undefined;
  }
};

// Profile content depends on the API version: the project's sourceApiVersion is used so that the retrieved
// profile only holds what the project deploys.
const projectApiVersion = async (project: SfProject | undefined): Promise<string | undefined> => {
  try {
    const config = await project?.resolveProjectConfig();
    return typeof config?.sourceApiVersion === 'string' ? config.sourceApiVersion : undefined;
  } catch {
    return undefined;
  }
};

const nonEmpty = (sources: ProfileSource[], origin: string): ProfileSource[] => {
  if (sources.length === 0) {
    throw messages.createError('error.noProfile', [origin]);
  }

  return sources;
};

// The profiles chosen by --source-dir, --metadata or --manifest, or every profile of the project.
const findSources = async (
  flags: { 'source-dir'?: string[]; metadata?: string[]; manifest?: string },
  project: SfProject | undefined,
  connection: Connection
): Promise<ProfileSource[]> => {
  if (flags['source-dir']) {
    return nonEmpty(findProfileSources(flags['source-dir']), flags['source-dir'].join(', '));
  }

  // Without --source-dir, the project is needed to find the profiles: SfProject.resolve explains a missing one.
  const resolvedProject = project ?? (await SfProject.resolve());
  const packageDirectories = resolvedProject.getPackageDirectories();
  const local = findProfileSources(packageDirectories.map((directory) => directory.fullPath));
  if (!flags.metadata && !flags.manifest) {
    return nonEmpty(local, packageDirectories.map((directory) => directory.path).join(', '));
  }

  let names: string[];
  if (flags.metadata) {
    names = flags.metadata.map((entry) => {
      const name = profileNameOfEntry(entry);
      if (name === undefined) {
        throw messages.createError('error.notProfile', [entry]);
      }

      return name;
    });
  } else {
    names = await profileNamesOfManifest(flags.manifest!);
  }

  const defaultDirectory = resolvedProject.getDefaultPackage().fullPath;
  const selected = await selectProfiles({
    names,
    local,
    newProfilesDir: path.join(defaultDirectory, 'main', 'default', 'profiles'),
    listOrgProfiles: () => listOrgProfiles(connection),
  });
  return nonEmpty(selected, flags.metadata?.join(', ') ?? flags.manifest!);
};

export default class ProfileRetrieve extends SfCommand<ProfileRetrieveResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  // Same names, characters and exclusions as `sf project retrieve start`.
  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion({
      char: 'a',
      summary: messages.getMessage('flags.api-version.summary'),
    }),
    'source-dir': Flags.string({
      char: 'd',
      multiple: true,
      exclusive: ['manifest', 'metadata'],
      summary: messages.getMessage('flags.source-dir.summary'),
      description: messages.getMessage('flags.source-dir.description'),
      // sfdx mdt:profile:retrieve name, kept so existing pipelines keep working.
      aliases: ['sourcepath'],
      deprecateAliases: true,
    }),
    metadata: Flags.string({
      char: 'm',
      multiple: true,
      exclusive: ['manifest', 'source-dir'],
      summary: messages.getMessage('flags.metadata.summary'),
      description: messages.getMessage('flags.metadata.description'),
    }),
    manifest: Flags.file({
      char: 'x',
      exists: true,
      exclusive: ['metadata', 'source-dir'],
      summary: messages.getMessage('flags.manifest.summary'),
      description: messages.getMessage('flags.manifest.description'),
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
    const project = await resolveProject();
    const connection = flags['target-org'].getConnection(flags['api-version'] ?? (await projectApiVersion(project)));
    const sources = await findSources(flags, project, connection);

    this.spinner.start(messages.getMessage('spinner.start', [connection.getApiVersion()]));
    this.spinner.status = `0/${sources.length}`;
    const result = await retrieveProfiles({
      connection,
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
