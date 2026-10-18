import { AuthInfo, Messages, Org } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';

import { gitRoot } from '../../../deploy/git.js';
import {
  mapOrg,
  mappedOrgs,
  readProjectFile,
  unmapOrg,
  withLocalAliases,
  type LocalOrg,
  type OrgMapResult,
} from '../../../deploy/org-map.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df.org.map');

const localOrgs = async (): Promise<LocalOrg[]> => {
  try {
    return await AuthInfo.listAllAuthorizations();
  } catch {
    return [];
  }
};

export default class OrgMap extends SfCommand<OrgMapResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.optionalOrg({
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    branch: Flags.string({
      char: 'b',
      summary: messages.getMessage('flags.branch.summary'),
      description: messages.getMessage('flags.branch.description'),
    }),
    remove: Flags.boolean({
      summary: messages.getMessage('flags.remove.summary'),
      exclusive: ['branch'],
    }),
  };

  public async run(): Promise<OrgMapResult> {
    const { flags } = await this.parse(OrgMap);
    const repoRoot = await gitRoot(process.cwd());
    const change = flags.branch !== undefined || flags.remove;
    const org: Org | undefined = flags['target-org'];
    const orgUrl = org?.getField<string>(Org.Fields.INSTANCE_URL);

    if (change && !orgUrl) {
      throw messages.createError('error.noOrg');
    }

    let result: Omit<OrgMapResult, 'orgs'> & { orgs: Array<{ url: string; branch: string }> };
    if (flags.branch !== undefined && orgUrl) {
      result = await mapOrg(repoRoot, orgUrl, flags.branch);
    } else if (flags.remove && orgUrl) {
      result = await unmapOrg(repoRoot, orgUrl);
    } else {
      const project = await readProjectFile(repoRoot);
      result = { action: 'list', projectFile: project.path, orgs: mappedOrgs(project) };
    }

    const orgs = withLocalAliases(result.orgs, await localOrgs());
    if (result.action === 'mapped' && result.previousBranch) {
      this.log(messages.getMessage('info.remapped', [orgUrl, flags.branch, result.previousBranch, result.projectFile]));
    } else if (result.action === 'mapped') {
      this.log(messages.getMessage('info.mapped', [orgUrl, flags.branch, result.projectFile]));
    } else if (result.action === 'unchanged') {
      this.log(messages.getMessage('info.unchanged', [orgUrl, flags.branch]));
    } else if (result.action === 'removed') {
      this.log(messages.getMessage('info.removed', [orgUrl, result.previousBranch, result.projectFile]));
    }

    if (orgs.length === 0) {
      this.log(messages.getMessage('info.empty'));
    } else {
      this.table({
        data: orgs.map((entry) => ({
          branch: entry.branch,
          url: entry.url,
          alias: entry.localAliases.join(', ') || messages.getMessage('info.notAuthenticated'),
        })),
        columns: [
          { key: 'branch', name: 'Branch' },
          { key: 'url', name: 'Org URL' },
          { key: 'alias', name: 'Local alias' },
        ],
      });
    }

    return { ...result, orgs };
  }
}
