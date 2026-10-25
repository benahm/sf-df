import type { Connection } from '@salesforce/core';

import { splitElements, unescapeXml } from './profile-filter.js';

// An entry of the org's profile that the same org refuses to deploy, left out of the file.
export type LeftOutEntry = {
  section: 'tabVisibilities' | 'layoutAssignments';
  // The tab, or the record type (the object for the master layout) assigned twice.
  name: string;
};

export type DeployableOptions = {
  // Standard tabs of the org (`standard-Account`). Undefined: the tab settings are all kept.
  standardTabs?: Set<string>;
};

// readMetadata returns settings for standard tabs that the org doesn't list in TabDefinition, and refuses at
// deployment (`You can't edit tab settings for AccountAccountRelation, as it's not a valid tab`, verified in a
// sandbox: 103 of the 480 standard tabs of the Admin profile).
export const listStandardTabs = async (connection: Connection): Promise<string[]> => {
  const { records } = await connection.tooling.query<{ Name: string }>(
    "SELECT Name FROM TabDefinition WHERE Name LIKE 'standard-%'",
    { autoFetch: true, maxFetch: 100_000 }
  );
  return records.map((record) => record.Name);
};

const childValue = (element: string, child: string): string | undefined => {
  const match = new RegExp(`<${child}>([^<]*)</${child}>`).exec(element);
  return match ? unescapeXml(match[1]) : undefined;
};

// Two assignments of the same object and record type are refused (`Duplicate layoutAssignment`). The org may hold
// them: two ProfileLayout rows for one person account record type, returned by readMetadata and by a native
// retrieve alike (verified in a sandbox). Which one applies can't be told, so both are left out: the deployment then
// leaves the target org's assignment as it is. `Case-X` and `CaseClose-Y` for one record type are not duplicates.
const assignmentKey = (element: string): { key: string; name: string } => {
  const layout = childValue(element, 'layout') ?? '';
  const objectName = layout.slice(0, layout.indexOf('-'));
  const recordType = childValue(element, 'recordType');
  return { key: `${objectName}:${recordType ?? ''}`.toLowerCase(), name: recordType ?? objectName };
};

// Leaves out of a profile written by formatMetadataFile the entries its own org refuses to deploy.
export const makeDeployable = (xml: string, options: DeployableOptions): { xml: string; leftOut: LeftOutEntry[] } => {
  const { head, elements, tail } = splitElements(xml);
  const standardTabs = options.standardTabs
    ? new Set([...options.standardTabs].map((name) => name.toLowerCase()))
    : undefined;

  const assignments = new Map<string, number>();
  for (const { tag, lines } of elements) {
    if (tag === 'layoutAssignments') {
      const { key } = assignmentKey(lines.join('\n'));
      assignments.set(key, (assignments.get(key) ?? 0) + 1);
    }
  }

  const leftOut: LeftOutEntry[] = [];
  const duplicates = new Set<string>();
  const kept = elements.filter(({ tag, lines }) => {
    const element = lines.join('\n');
    if (tag === 'tabVisibilities' && standardTabs) {
      const tab = childValue(element, 'tab') ?? '';
      if (tab.startsWith('standard-') && !standardTabs.has(tab.toLowerCase())) {
        leftOut.push({ section: tag, name: tab });
        return false;
      }
    }

    if (tag === 'layoutAssignments') {
      const { key, name } = assignmentKey(element);
      if ((assignments.get(key) ?? 0) > 1) {
        if (!duplicates.has(key)) {
          duplicates.add(key);
          leftOut.push({ section: tag, name });
        }

        return false;
      }
    }

    return true;
  });

  return leftOut.length === 0
    ? { xml, leftOut }
    : { xml: [...head, ...kept.flatMap(({ lines }) => lines), ...tail].join('\n'), leftOut };
};
