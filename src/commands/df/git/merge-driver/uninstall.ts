import { Messages } from '@salesforce/core';
import { SfCommand } from '@salesforce/sf-plugins-core';

import { uninstallMergeDriver, type MergeDriverUninstallResult } from '../../../../merge/install.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df.git.merge-driver.uninstall');

export default class MergeDriverUninstall extends SfCommand<MergeDriverUninstallResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public async run(): Promise<MergeDriverUninstallResult> {
    await this.parse(MergeDriverUninstall);
    const result = await uninstallMergeDriver(process.cwd());

    this.log(messages.getMessage('info.removed', [String(result.removedPatterns.length), result.gitattributesPath]));
    return result;
  }
}
