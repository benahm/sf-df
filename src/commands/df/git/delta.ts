import path from 'node:path';

import type { Interfaces } from '@oclif/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { SfCommand } from '@salesforce/sf-plugins-core';

import { generateDelta } from '../../../delta/engine.js';
import type { DeltaResult } from '../../../delta/types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df.git.delta');

export default class GitDelta extends SfCommand<DeltaResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags: Interfaces.FlagInput = {
    from: Flags.string({
      char: 'f',
      required: true,
      summary: messages.getMessage('flags.from.summary'),
      description: messages.getMessage('flags.from.description'),
    }),
    to: Flags.string({
      char: 't',
      summary: messages.getMessage('flags.to.summary'),
      description: messages.getMessage('flags.to.description'),
    }),
    'output-dir': Flags.directory({
      char: 'd',
      required: true,
      summary: messages.getMessage('flags.output-dir.summary'),
      description: messages.getMessage('flags.output-dir.description'),
    }),
    'source-dir': Flags.directory({
      char: 's',
      default: 'force-app/main/default',
      summary: messages.getMessage('flags.source-dir.summary'),
      description: messages.getMessage('flags.source-dir.description'),
    }),
  };

  public async run(): Promise<DeltaResult> {
    const { flags } = await this.parse(GitDelta);
    this.spinner.start(messages.getMessage('spinner.start'));

    try {
      const result = await generateDelta({
        repoRoot: process.cwd(),
        from: String(flags.from),
        to: flags.to ? String(flags.to) : undefined,
        sourceDir: String(flags['source-dir']),
        outputDir: path.resolve(String(flags['output-dir'])),
      });

      this.spinner.stop(messages.getMessage('spinner.success'));
      this.log(messages.getMessage('info.summary', [String(result.processedChanges)]));

      for (const warning of result.warnings) {
        this.warn(warning);
      }

      return result;
    } catch (error) {
      this.spinner.stop(messages.getMessage('spinner.error'));
      throw error;
    }
  }
}
