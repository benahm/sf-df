import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ComponentSet, type SourceComponent } from '@salesforce/source-deploy-retrieve';

const quoteCmdArg = (arg: string): string => (/[\s"]/u.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg);

export const runSf = (args: string[], cwd: string): string => {
  const [command, commandArgs] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', `sf ${args.map(quoteCmdArg).join(' ')}`]]
      : ['sf', args];
  try {
    return execFileSync(command, commandArgs, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // sf exits non-zero on failed deployments but still prints the JSON result.
    return String((error as { stdout?: string }).stdout ?? '');
  }
};

export const parseSfJson = <T>(raw: string): T => JSON.parse(raw.slice(raw.indexOf('{'))) as T;

// `Type:fullName` of every addressable component (children included) found in a source folder.
export const componentsInSource = (sourceDir: string): Set<string> => {
  if (!existsSync(sourceDir)) {
    return new Set();
  }

  const entries = new Set<string>();
  const add = (component: SourceComponent): void => {
    if (component.isAddressable) {
      entries.add(`${component.type.name}:${component.fullName}`);
    }
    component.getChildren().forEach(add);
  };
  ComponentSet.fromSource(sourceDir).getSourceComponents().toArray().forEach(add);
  return entries;
};

export type DeployOutcome = { status: number; failures: string[]; errorMessage?: string };

// Deploys a delta in one transaction (package.xml + post-destructive changes), like a CI pipeline would.
export const deployDelta = (outputDir: string, repoRoot: string, targetOrg: string): DeployOutcome => {
  const packageDir = path.join(outputDir, 'package');
  mkdirSync(path.join(packageDir, 'force-app'), { recursive: true });
  writeFileSync(path.join(packageDir, 'sfdx-project.json'), readFileSync(path.join(repoRoot, 'sfdx-project.json')));
  const destructive = path.join(outputDir, 'destructive', 'destructiveChanges.xml');
  const args = ['project', 'deploy', 'start', '-x', 'package.xml', '-o', targetOrg, '-w', '60', '--ignore-conflicts', '--json'];
  if (existsSync(destructive)) {
    args.push('--post-destructive-changes', destructive);
  }

  const result = parseSfJson<{
    status: number;
    result?: { errorMessage?: string; details?: { componentFailures?: unknown } };
  }>(runSf(args, packageDir));
  const failures = ([] as Array<{ componentType: string; fullName: string; problem: string }>)
    .concat((result.result?.details?.componentFailures as never) ?? [])
    .map((failure) => `${failure.componentType}:${failure.fullName} ${failure.problem}`);
  return { status: result.status, failures, errorMessage: result.result?.errorMessage };
};

// Retrieves the given components into a temp source folder; components missing from the org are simply absent.
export const retrieveFromOrg = (components: Iterable<string>, targetOrg: string): { present: Set<string>; dir: string } => {
  const work = mkdtempSync(path.join(tmpdir(), 'sf-df-e2e-retrieve-'));
  const byType = new Map<string, string[]>();
  for (const entry of components) {
    const [type, ...rest] = entry.split(':');
    byType.set(type, [...(byType.get(type) ?? []), rest.join(':')]);
  }

  writeFileSync(
    path.join(work, 'package.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${[...byType]
      .map(([type, members]) => `<types>${members.map((m) => `<members>${m}</members>`).join('')}<name>${type}</name></types>`)
      .join('\n')}\n<version>64.0</version>\n</Package>\n`
  );
  writeFileSync(path.join(work, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'retrieved', default: true }] }));
  mkdirSync(path.join(work, 'retrieved'));
  runSf(['project', 'retrieve', 'start', '-x', 'package.xml', '-o', targetOrg, '-w', '30', '--json'], work);
  const dir = path.join(work, 'retrieved');
  return { present: componentsInSource(dir), dir };
};

export const readAll = (dir: string, pathPattern: RegExp): string => {
  const contents: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (pathPattern.test(full.replaceAll('\\', '/'))) {
        contents.push(readFileSync(full, 'utf8'));
      }
    }
  };
  walk(dir);
  return contents.join('\n');
};
