import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { pathExists } from '../delta/fs.js';
import { mergeDriverPatterns } from './merge-rules.js';

const execFileAsync = promisify(execFile);

export const DRIVER_NAME = 'deltaforce';
// %P is quoted by git; the temporary files never contain spaces.
export const DRIVER_COMMAND =
  'sf df git merge-driver run --ancestor %O --current %A --other %B --marker-size %L --path %P';
const ATTRIBUTE = `merge=${DRIVER_NAME}`;
const HEADER = '# Salesforce metadata merged by key (sf df git merge-driver install)';

export type MergeDriverInstallResult = {
  driver: string;
  gitattributesPath: string;
  patterns: string[];
  addedPatterns: string[];
};

export type MergeDriverUninstallResult = {
  gitattributesPath: string;
  removedPatterns: string[];
};

const git = async (cwd: string, args: string[]): Promise<string> =>
  (await execFileAsync('git', args, { cwd })).stdout.trim();

const readGitattributes = async (cwd: string): Promise<{ filePath: string; lines: string[]; eol: string }> => {
  const filePath = path.join(await git(cwd, ['rev-parse', '--show-toplevel']), '.gitattributes');
  const content = (await pathExists(filePath)) ? await readFile(filePath, 'utf8') : '';
  const lines = content === '' ? [] : content.replace(/\r?\n$/, '').split(/\r?\n/);
  return { filePath, lines, eol: content.includes('\r\n') ? '\r\n' : '\n' };
};

const declaresDriver = (line: string): boolean => line.trim().split(/\s+/).slice(1).includes(ATTRIBUTE);

// The driver is declared in the local git config (not versioned: each clone runs install) and the files it
// handles in .gitattributes (versioned: shared by the team). Running it again only adds what is missing.
export const installMergeDriver = async (cwd: string): Promise<MergeDriverInstallResult> => {
  await git(cwd, ['config', `merge.${DRIVER_NAME}.name`, 'Salesforce metadata merged by key (sf-df)']);
  await git(cwd, ['config', `merge.${DRIVER_NAME}.driver`, DRIVER_COMMAND]);

  const { filePath, lines, eol } = await readGitattributes(cwd);
  const patterns = mergeDriverPatterns();
  const declared = new Set(lines.filter(declaresDriver).map((line) => line.trim().split(/\s+/)[0]));
  const addedPatterns = patterns.filter((pattern) => !declared.has(pattern));

  if (addedPatterns.length > 0) {
    const block = [...(lines.includes(HEADER) ? [] : [HEADER]), ...addedPatterns.map((pattern) => `${pattern} ${ATTRIBUTE}`)];
    const separator = lines.length > 0 && !lines.includes(HEADER) ? [''] : [];
    await writeFile(filePath, [...lines, ...separator, ...block].join(eol) + eol, 'utf8');
  }

  return { driver: DRIVER_COMMAND, gitattributesPath: filePath, patterns, addedPatterns };
};

export const uninstallMergeDriver = async (cwd: string): Promise<MergeDriverUninstallResult> => {
  try {
    await git(cwd, ['config', '--remove-section', `merge.${DRIVER_NAME}`]);
  } catch {
    // Not installed in this clone.
  }

  const { filePath, lines, eol } = await readGitattributes(cwd);
  const removed = lines.filter(declaresDriver);
  if (removed.length > 0 || lines.includes(HEADER)) {
    const kept = lines.filter((line) => line !== HEADER && !declaresDriver(line));
    while (kept.length > 0 && kept.at(-1)?.trim() === '') {
      kept.pop();
    }

    await (kept.length > 0 ? writeFile(filePath, kept.join(eol) + eol, 'utf8') : rm(filePath));
  }

  return { gitattributesPath: filePath, removedPatterns: removed.map((line) => line.trim().split(/\s+/)[0]) };
};
