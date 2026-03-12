import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import type { Interfaces } from '@oclif/core';
import { Messages } from '@salesforce/core';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df');

export type DfResult = {
  name: string;
  time: string;
};

export default class Df extends SfCommand<DfResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags: Interfaces.FlagInput = {
    name: Flags.string({
      char: 'n',
      summary: messages.getMessage('flags.name.summary'),
      description: messages.getMessage('flags.name.description'),
      default: 'Deltaforce',
    }),
  };

  public async run(): Promise<DfResult> {
    const { flags } = await this.parse(Df);
    const name = String(flags.name);
    const time = new Date().toDateString();
    this.log(messages.getMessage('info.df', [name, time]));
    return {
      name,
      time,
    };
  }
}
