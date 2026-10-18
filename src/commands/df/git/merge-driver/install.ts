import { Messages } from '@salesforce/core';
import { SfCommand } from '@salesforce/sf-plugins-core';

import { installMergeDriver, type MergeDriverInstallResult } from '../../../../merge/install.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df.git.merge-driver.install');

export default class MergeDriverInstall extends SfCommand<MergeDriverInstallResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public async run(): Promise<MergeDriverInstallResult> {
    await this.parse(MergeDriverInstall);
    const result = await installMergeDriver(process.cwd());

    this.log(messages.getMessage('info.driver', [result.driver]));
    this.log(
      result.addedPatterns.length > 0
        ? messages.getMessage('info.added', [result.gitattributesPath, result.addedPatterns.join(', ')])
        : messages.getMessage('info.upToDate', [result.gitattributesPath])
    );
    return result;
  }
}
