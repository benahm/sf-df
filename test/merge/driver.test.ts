import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { runMergeDriver } from '../../src/merge/driver.js';

const HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const labelsXml = (labels: Array<[string, string]>): string =>
  `${HEADER}<CustomLabels ${NS}>\n${labels
    .map(([name, value]) => `    <labels>\n        <fullName>${name}</fullName>\n        <value>${value}</value>\n    </labels>\n`)
    .join('')}</CustomLabels>\n`;

// apiVersion and status are far enough apart for git to merge a change to each.
const apexMetaXml = (apiVersion: string, status = 'Active'): string =>
  `${HEADER}<ApexClass ${NS}>\n    <apiVersion>${apiVersion}</apiVersion>\n    <packageVersions>\n        <namespace>ns</namespace>\n    </packageVersions>\n    <status>${status}</status>\n</ApexClass>\n`;

describe('runMergeDriver', () => {
  let dir: string;
  let files: { ancestor: string; current: string; other: string };

  const write = async (base: string, ours: string, theirs: string): Promise<void> => {
    await Promise.all([writeFile(files.ancestor, base), writeFile(files.current, ours), writeFile(files.other, theirs)]);
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sf-df-driver-'));
    files = { ancestor: path.join(dir, 'O'), current: path.join(dir, 'A'), other: path.join(dir, 'B') };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the merge by key in the current file', async () => {
    await write(labelsXml([['A', 'a'], ['B', 'b']]), labelsXml([['A', 'a1'], ['B', 'b']]), labelsXml([['A', 'a'], ['B', 'b1']]));

    const result = await runMergeDriver({ ...files, path: 'labels/CustomLabels.labels-meta.xml' });

    expect(result).to.deep.equal({ path: 'labels/CustomLabels.labels-meta.xml', strategy: 'xml', conflicts: 0 });
    expect(await readFile(files.current, 'utf8')).to.equal(labelsXml([['A', 'a1'], ['B', 'b1']]));
  });

  it('counts the conflicts left by the merge by key', async () => {
    await write(labelsXml([['A', 'a']]), labelsXml([['A', 'a1']]), labelsXml([['A', 'a2']]));

    const result = await runMergeDriver({ ...files, markerSize: 9 });

    expect(result).to.deep.include({ strategy: 'xml', conflicts: 1 });
    expect(await readFile(files.current, 'utf8')).to.contain('\n<<<<<<<<< ours\n');
  });

  it('falls back to the line merge of git for the other files', async () => {
    await write(apexMetaXml('60.0'), apexMetaXml('61.0'), apexMetaXml('60.0', 'Deleted'));

    expect(await runMergeDriver(files)).to.deep.include({ strategy: 'text', conflicts: 0 });
    expect(await readFile(files.current, 'utf8')).to.equal(apexMetaXml('61.0', 'Deleted'));
  });

  it('reports the conflicts of the line merge', async () => {
    await write(apexMetaXml('60.0'), apexMetaXml('61.0'), apexMetaXml('62.0'));

    expect(await runMergeDriver(files)).to.deep.include({ strategy: 'text', conflicts: 1 });
    expect(await readFile(files.current, 'utf8')).to.contain('<<<<<<< ours');
  });
});
