import { expect } from 'chai';

import { formatMetadataFile } from '../../src/retrieve/metadata-read.js';
import { makeDeployable } from '../../src/retrieve/profile-deployable.js';

const profile = (...entries: string[]): string => formatMetadataFile('Profile', entries.join(''));
const tab = (name: string): string =>
  `<tabVisibilities><tab>${name}</tab><visibility>DefaultOn</visibility></tabVisibilities>`;
const assignment = (layout: string, recordType?: string): string =>
  `<layoutAssignments><layout>${layout}</layout>${recordType ? `<recordType>${recordType}</recordType>` : ''}</layoutAssignments>`;

describe('profile that deploys', () => {
  // Verified in a sandbox: the org returns these settings and refuses them (`not a valid tab`).
  it('leaves out the settings of standard tabs the org does not list, whatever their case', () => {
    const xml = profile(tab('Invoice__c'), tab('standard-Account'), tab('standard-AccountAccountRelation'));

    const result = makeDeployable(xml, { standardTabs: new Set(['STANDARD-ACCOUNT']) });

    expect(result.leftOut).to.deep.equal([{ section: 'tabVisibilities', name: 'standard-AccountAccountRelation' }]);
    expect(result.xml).to.equal(profile(tab('Invoice__c'), tab('standard-Account')));
  });

  it('keeps every tab setting when the standard tabs are unknown', () => {
    const xml = profile(tab('standard-AccountAccountRelation'));

    expect(makeDeployable(xml, {})).to.deep.equal({ xml, leftOut: [] });
  });

  // Verified in a sandbox: two ProfileLayout rows for one person account record type, returned by readMetadata and
  // by `sf project retrieve start` alike, refused at deployment (`Duplicate layoutAssignment`).
  it('leaves out both layouts assigned to the same record type', () => {
    const xml = profile(
      assignment('Account-Account Layout'),
      assignment('Case-Claims Layout', 'Case.Claims'),
      assignment('CaseClose-Closing Layout', 'Case.Claims'),
      assignment('PersonAccount-Client Layout', 'PersonAccount.Client'),
      assignment('PersonAccount-Retail Layout', 'PersonAccount.Client'),
      assignment('PersonAccount-Client Layout', 'PersonAccount.Prospect')
    );

    const result = makeDeployable(xml, {});

    expect(result.leftOut).to.deep.equal([{ section: 'layoutAssignments', name: 'PersonAccount.Client' }]);
    expect(result.xml).to.equal(
      profile(
        assignment('Account-Account Layout'),
        assignment('Case-Claims Layout', 'Case.Claims'),
        assignment('CaseClose-Closing Layout', 'Case.Claims'),
        assignment('PersonAccount-Client Layout', 'PersonAccount.Prospect')
      )
    );
  });
});
