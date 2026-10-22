import path from 'node:path';

import { expect } from 'chai';

import { profileNameOfEntry, selectProfiles } from '../../src/retrieve/profile-selection.js';

const NEW_DIR = path.join('force-app', 'main', 'default', 'profiles');

describe('profile selection', () => {
  it('reads --metadata entries as sf project retrieve start does', () => {
    expect(profileNameOfEntry('Profile')).to.equal('*');
    expect(profileNameOfEntry('Profile:Admin')).to.equal('Admin');
    expect(profileNameOfEntry('Profile: Sales: EMEA ')).to.equal('Sales: EMEA');
    expect(profileNameOfEntry('ApexClass:Foo')).to.equal(undefined);
  });

  it('lists the org only for a wildcard', async () => {
    let listed = false;
    const selected = await selectProfiles({
      names: ['Admin'],
      local: [],
      newProfilesDir: NEW_DIR,
      listOrgProfiles: async () => {
        listed = true;
        return [];
      },
    });

    expect(selected).to.deep.equal([{ fullName: 'Admin', filePath: path.join(NEW_DIR, 'Admin.profile-meta.xml') }]);
    expect(listed).to.equal(false);
  });

  it('matches * on the whole name, and nothing else as a pattern', async () => {
    const selected = await selectProfiles({
      names: ['Sales*', 'Ops (EU)*'],
      local: [],
      newProfilesDir: NEW_DIR,
      listOrgProfiles: async () => ['Sales Rep', 'Pre Sales', 'Ops (EU) Lead', 'Ops EU Lead'],
    });

    expect(selected.map(({ fullName }) => fullName)).to.deep.equal(['Ops (EU) Lead', 'Sales Rep']);
  });

  it('keeps the file of the project, whatever the encoding of the name, and never selects a profile twice', async () => {
    const local = {
      fullName: 'System Admin %2B Bulk Delete Permission',
      filePath: 'profiles/System Admin %2B Bulk Delete Permission.profile-meta.xml',
    };

    const selected = await selectProfiles({
      names: ['System Admin + Bulk Delete Permission', 'System*'],
      local: [local],
      newProfilesDir: NEW_DIR,
      listOrgProfiles: async () => ['System Admin %2B Bulk Delete Permission'],
    });

    expect(selected).to.deep.equal([local]);
  });
});
