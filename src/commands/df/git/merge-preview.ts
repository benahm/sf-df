import { Messages } from '@salesforce/core';
import { Flags, SfCommand, StandardColors } from '@salesforce/sf-plugins-core';
import ansis from 'ansis';

import { previewMerge, type MergePreviewResult } from '../../../merge/preview.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df.git.merge-preview');

export default class GitMergePreview extends SfCommand<MergePreviewResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    from: Flags.string({
      char: 'f',
      required: true,
      summary: messages.getMessage('flags.from.summary'),
      description: messages.getMessage('flags.from.description'),
    }),
    into: Flags.string({
      char: 'i',
      required: true,
      summary: messages.getMessage('flags.into.summary'),
      description: messages.getMessage('flags.into.description'),
    }),
    message: Flags.string({
      char: 'm',
      summary: messages.getMessage('flags.message.summary'),
    }),
  };

  public async run(): Promise<MergePreviewResult> {
    const { flags } = await this.parse(GitMergePreview);
    const result = await previewMerge({ cwd: process.cwd(), from: flags.from, into: flags.into, message: flags.message });

    if (result.conflicts.length > 0) {
      this.log(ansis.bold.red(messages.getMessage('info.conflicts', [flags.from, flags.into, String(result.conflicts.length)])));
      for (const file of result.conflicts) {
        this.log(`  ${file}`);
      }

      this.log();
      this.log(StandardColors.info(messages.getMessage('info.resolve', [flags.into, flags.from])));
      // A script tests the exit code: a merge that can't be made is not a success.
      process.exitCode = 1;
      return result;
    }

    if (result.alreadyMerged) {
      this.log(ansis.bold(messages.getMessage('info.alreadyMerged', [flags.from, flags.into])));
      return result;
    }

    this.log(ansis.bold.green(messages.getMessage('info.merged', [flags.from, flags.into])));
    this.log(`${messages.getMessage('info.commit')} ${ansis.bold(result.commit)}`);
    this.log();
    this.log(StandardColors.info(messages.getMessage('info.next')));
    this.log(StandardColors.info(`  sf df git delta --from ${flags.into} --to ${result.commit} --deploy-dir delta`));
    this.log(StandardColors.info(`  git push <remote> ${result.commit}:refs/heads/<branch>`));
    return result;
  }
}
