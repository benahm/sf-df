import path from 'node:path';

import { Messages } from '@salesforce/core';
import { Flags, SfCommand, StandardColors } from '@salesforce/sf-plugins-core';
import ansis from 'ansis';

import { generateDelta } from '../../../delta/engine.js';
import type { DeltaComponentAction, DeltaResult, GitChangeStatus } from '../../../delta/types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-df', 'df.git.delta');

export default class GitDelta extends SfCommand<DeltaResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
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
    'deploy-dir': Flags.directory({
      char: 'd',
      required: true,
      summary: messages.getMessage('flags.deploy-dir.summary'),
      description: messages.getMessage('flags.deploy-dir.description'),
      // sfdx mdt:git:delta name, kept so existing pipelines keep working.
      aliases: ['packagedir'],
      deprecateAliases: true,
    }),
    'destructive-dir': Flags.directory({
      summary: messages.getMessage('flags.destructive-dir.summary'),
      description: messages.getMessage('flags.destructive-dir.description'),
      // sfdx mdt:git:delta name (with its typo), kept so existing pipelines keep working.
      aliases: ['descructivedir'],
      deprecateAliases: true,
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
        from: flags.from,
        to: flags.to,
        sourceDir: flags['source-dir'],
        deployDir: flags['deploy-dir'],
        destructiveDir: flags['destructive-dir'],
      });

      this.spinner.stop(messages.getMessage('spinner.success'));
      this.report(result);

      for (const warning of result.warnings) {
        this.warn(warning);
      }

      return result;
    } catch (error) {
      this.spinner.stop(messages.getMessage('spinner.error'));
      throw error;
    }
  }

  private report(result: DeltaResult): void {
    const fromSourceDir = (file: string): string =>
      file.startsWith(`${result.sourceDir}/`) ? file.slice(result.sourceDir.length + 1) : file;
    const changes = (Object.entries(result.countsByStatus) as Array<[GitChangeStatus, number]>).filter(([, count]) => count > 0);
    const changedFiles = changes.reduce((total, [, count]) => total + count, 0);

    this.log(
      ansis.bold(messages.getMessage('info.range', [result.from, result.to ?? messages.getMessage('info.workingTree')])) +
        StandardColors.info(` (${result.sourceDir})`)
    );
    this.log(
      changedFiles === 0
        ? messages.getMessage('info.noChange')
        : messages.getMessage('info.changedFiles', [
            plural(changedFiles, 'changed file'),
            changes.map(([status, count]) => `${count} ${STATUS_LABELS[status]}`).join(', '),
          ])
    );

    const sections = (['package', 'destructive'] as const).map((manifest) => ({
      manifest,
      components: result.components
        .filter((component) => component.manifest === manifest)
        .sort((a, b) => a.type.localeCompare(b.type) || a.fullName.localeCompare(b.fullName)),
    }));

    // A table ends with its own blank line: the next section only needs one when no table came before.
    let afterTable = false;
    for (const { manifest, components } of sections) {
      if (components.length === 0) {
        continue;
      }

      const manifestPath = manifest === 'package' ? result.packageManifestPath : result.destructiveManifestPath!;
      this.header(
        messages.getMessage(`info.header.${manifest}`, [plural(components.length, 'component')]),
        path.relative(process.cwd(), manifestPath),
        !afterTable
      );
      // One row per file: @oclif/table does not pad the lines of a multi-line cell, which breaks its border.
      this.table({
        data: components.flatMap((component) =>
          displayedFiles(component.files.map(fromSourceDir)).map((file, index) =>
            index === 0
              ? { action: ACTION_LABELS[component.action], type: component.type, name: component.fullName, files: file }
              : { action: '', type: '', name: '', files: file }
          )
        ),
        columns: [
          { key: 'action', name: 'Action' },
          { key: 'type', name: 'Type' },
          { key: 'name', name: 'Name' },
          { key: 'files', name: `Files (in ${result.sourceDir})` },
        ],
      });
      afterTable = true;
    }

    const [deployed, deleted] = sections.map(({ components }) => components.length);
    if (!afterTable) {
      this.log();
    }

    this.log(
      deployed + deleted === 0
        ? ansis.bold(messages.getMessage('info.nothingToDeploy'))
        : ansis.bold.green(messages.getMessage('info.ready', [plural(deployed, 'component'), String(deleted)])) +
            (result.warnings.length > 0 ? ansis.yellow(` · ${plural(result.warnings.length, 'warning')}`) : '')
    );
  }

  // A section title: one emoji, bold, then where it is written.
  private header(title: string, location?: string, blankLineBefore = true): void {
    if (blankLineBefore) {
      this.log();
    }

    this.log(ansis.bold(title) + (location ? StandardColors.info(` → ${location}`) : ''));
  }
}

const STATUS_LABELS: Record<GitChangeStatus, string> = { add: 'added', modify: 'modified', delete: 'deleted', rename: 'renamed' };

const ACTION_LABELS: Record<DeltaComponentAction, string> = {
  // Single-width symbols only: an emoji in a cell is drawn one or two columns wide depending on the terminal, which
  // breaks the borders of the table.
  add: ansis.green('+ Added'),
  modify: ansis.yellow('~ Modified'),
  rename: ansis.cyan('→ Renamed'),
  deactivate: ansis.magenta('⊘ Deactivated'),
  delete: ansis.red('− Deleted'),
};

const MAX_DISPLAYED_FILES = 3;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

// The -meta.xml next to its source file (Foo.cls and Foo.cls-meta.xml) adds nothing to read.
const displayedFiles = (files: string[]): string[] => {
  const shown = files.filter((file) => !(file.endsWith('-meta.xml') && files.includes(file.slice(0, -'-meta.xml'.length))));
  const lines = shown.slice(0, MAX_DISPLAYED_FILES);
  if (shown.length > MAX_DISPLAYED_FILES) {
    lines.push(StandardColors.info(`+${shown.length - MAX_DISPLAYED_FILES} more`));
  }

  return lines;
};
