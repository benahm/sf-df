import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Messages } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';

import { permissionSetNameOf, profileToPermissionSet } from '../../../profile/to-permset.js';
import { findProfileSources, type ProfileSource } from '../../../retrieve/profile-retrieve.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df.profile.to-permset');

export type ConvertedProfile = {
  profile: string;
  profilePath: string;
  // False when the profile was left as it is: --keep-profile, a standard profile, or nothing to revoke.
  profileChanged: boolean;
  standardProfile: boolean;
  permissionSet: string;
  permissionSetPath: string;
  // Entries copied to the permission set, per section of the profile.
  moved: Record<string, number>;
};

export type ProfileToPermsetResult = {
  profiles: ConvertedProfile[];
};

// File names keep the encoded name (`System Admin %2B Bulk Delete Permission`).
const decodedName = (fullName: string): string => {
  try {
    return decodeURIComponent(fullName);
  } catch {
    return fullName;
  }
};

// Next to the profiles folder, where `sf project retrieve start` writes permission sets.
const permissionSetPathOf = (source: ProfileSource, name: string, outputDir: string | undefined): string =>
  path.join(
    outputDir ?? path.join(path.dirname(path.dirname(source.filePath)), 'permissionsets'),
    `${name}.permissionset-meta.xml`
  );

export default class ProfileToPermset extends SfCommand<ProfileToPermsetResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'source-dir': Flags.string({
      char: 'd',
      multiple: true,
      required: true,
      summary: messages.getMessage('flags.source-dir.summary'),
      description: messages.getMessage('flags.source-dir.description'),
    }),
    name: Flags.string({
      char: 'n',
      summary: messages.getMessage('flags.name.summary'),
      description: messages.getMessage('flags.name.description'),
    }),
    label: Flags.string({
      char: 'l',
      summary: messages.getMessage('flags.label.summary'),
    }),
    'output-dir': Flags.directory({
      char: 'r',
      summary: messages.getMessage('flags.output-dir.summary'),
    }),
    'keep-profile': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.keep-profile.summary'),
      description: messages.getMessage('flags.keep-profile.description'),
    }),
  };

  public async run(): Promise<ProfileToPermsetResult> {
    const { flags } = await this.parse(ProfileToPermset);
    const sources = findProfileSources(flags['source-dir'].map((sourcePath) => path.resolve(sourcePath)));
    if (sources.length === 0) {
      throw messages.createError('error.noProfile', [flags['source-dir'].join(', ')]);
    }

    if ((flags.name ?? flags.label) !== undefined && sources.length > 1) {
      throw messages.createError('error.nameNeedsOneProfile', [sources.length]);
    }

    const outputDir = flags['output-dir'] ? path.resolve(flags['output-dir']) : undefined;
    const planned = await Promise.all(
      sources.map(async (source) => {
        const profileName = decodedName(source.fullName);
        const name = flags.name ?? permissionSetNameOf(profileName);
        const converted = profileToPermissionSet({
          profileXml: await readFile(source.filePath, 'utf8'),
          name,
          label: (flags.label ?? profileName).slice(0, 80),
          description: messages.getMessage('permissionSet.description', [profileName]),
          keepProfile: flags['keep-profile'],
        });
        const filePath = permissionSetPathOf(source, name, outputDir);
        return { source, name, filePath, converted, existing: await readFile(filePath, 'utf8').catch(() => undefined) };
      })
    );

    // Checked before any file is written: a failure leaves the project as it was. The permission set of an earlier
    // run is accepted when unchanged, so that a run with --keep-profile can be followed by one without.
    const seen = new Set<string>();
    for (const { name, filePath, converted, existing } of planned) {
      if (seen.has(filePath.toLowerCase()) || (existing !== undefined && existing !== converted.permissionSetXml)) {
        throw messages.createError('error.permissionSetExists', [name, filePath]);
      }

      seen.add(filePath.toLowerCase());
    }

    const profiles: ConvertedProfile[] = [];
    for (const { source, name, filePath, converted, existing } of planned) {
      if (existing === undefined) {
        // eslint-disable-next-line no-await-in-loop
        await mkdir(path.dirname(filePath), { recursive: true });
        // eslint-disable-next-line no-await-in-loop
        await writeFile(filePath, converted.permissionSetXml, 'utf8');
      }

      if (converted.profileXml !== undefined) {
        // eslint-disable-next-line no-await-in-loop
        await writeFile(source.filePath, converted.profileXml, 'utf8');
      }

      profiles.push({
        profile: source.fullName,
        profilePath: source.filePath,
        profileChanged: converted.profileXml !== undefined,
        standardProfile: converted.standardProfile,
        permissionSet: name,
        permissionSetPath: filePath,
        moved: converted.moved,
      });
    }

    this.report(profiles);
    return { profiles };
  }

  private report(profiles: ConvertedProfile[]): void {
    const cwd = process.cwd();
    this.table({
      data: profiles.map((profile) => ({
        profile: profile.profile,
        permissionSet: path.relative(cwd, profile.permissionSetPath),
        entries: Object.values(profile.moved).reduce((total, count) => total + count, 0),
        profileChanged: profile.profileChanged ? 'revoked' : 'unchanged',
      })),
      columns: [
        { key: 'profile', name: 'Profile' },
        { key: 'permissionSet', name: 'Permission set' },
        { key: 'entries', name: 'Accesses copied' },
        { key: 'profileChanged', name: 'Profile' },
      ],
    });

    for (const profile of profiles.filter(({ standardProfile }) => standardProfile)) {
      this.warn(messages.getMessage('warning.standardProfile', [profile.profile]));
    }

    if (profiles.some(({ profileChanged }) => profileChanged)) {
      this.warn(messages.getMessage('warning.deployOrder'));
    }
  }
}
