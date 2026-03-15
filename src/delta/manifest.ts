import { create } from 'xmlbuilder2';

import type { ManifestEntry } from './types.js';

const API_VERSION = '61.0';

export const buildManifestXml = (entries: ManifestEntry[]): string => {
  const grouped = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (!grouped.has(entry.type)) {
      grouped.set(entry.type, new Set<string>());
    }
    grouped.get(entry.type)?.add(entry.fullName);
  }

  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele('Package', {
    xmlns: 'http://soap.sforce.com/2006/04/metadata',
  });

  for (const typeName of [...grouped.keys()].sort()) {
    const typeElement = root.ele('types');
    for (const member of [...(grouped.get(typeName) ?? [])].sort()) {
      typeElement.ele('members').txt(member);
    }
    typeElement.ele('name').txt(typeName);
  }

  root.ele('version').txt(API_VERSION);

  return root.end({ prettyPrint: true });
};
