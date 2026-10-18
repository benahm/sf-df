import { Messages } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';

import { runMergeDriver, type MergeDriverResult } from '../../../../merge/driver.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df.git.merge-driver.run');

export default class MergeDriverRun extends SfCommand<MergeDriverResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    ancestor: Flags.file({
      required: true,
      exists: true,
      summary: messages.getMessage('flags.ancestor.summary'),
    }),
    current: Flags.file({
      required: true,
      exists: true,
      summary: messages.getMessage('flags.current.summary'),
      description: messages.getMessage('flags.current.description'),
    }),
    other: Flags.file({
      required: true,
      exists: true,
      summary: messages.getMessage('flags.other.summary'),
    }),
    'marker-size': Flags.integer({
      default: 7,
      min: 1,
      summary: messages.getMessage('flags.marker-size.summary'),
    }),
    path: Flags.string({
      summary: messages.getMessage('flags.path.summary'),
    }),
  };

  public async run(): Promise<MergeDriverResult> {
    const { flags } = await this.parse(MergeDriverRun);
    const result = await runMergeDriver({
      ancestor: flags.ancestor,
      current: flags.current,
      other: flags.other,
      markerSize: flags['marker-size'],
      path: flags.path,
    });

    // git reads the exit code: anything but 0 leaves the file in conflict.
    if (result.conflicts > 0) {
      this.warn(messages.getMessage('warning.conflicts', [String(result.conflicts), flags.path ?? flags.current]));
      process.exitCode = 1;
    }

    return result;
  }
}
