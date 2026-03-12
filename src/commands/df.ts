import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
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

  public static readonly flags = {
    name: Flags.string({
      char: 'n',
      summary: messages.getMessage('flags.name.summary'),
      description: messages.getMessage('flags.name.description'),
      default: 'Deltaforce',
    }),
  };

  public async run(): Promise<DfResult> {
    const { flags } = await this.parse(Df);
    const time = new Date().toDateString();
    this.log(messages.getMessage('info.df', [flags.name, time]));
    return {
      name: flags.name,
      time,
    };
  }
}
