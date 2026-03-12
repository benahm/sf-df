import { XMLBuilder, XMLParser } from 'fast-xml-parser';

export type XmlKeyRule = {
  keySelector: (item: Record<string, unknown>) => string;
  supportsDelete?: boolean;
};

export type XmlCollectionRules = Record<string, XmlKeyRule>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: false,
  suppressBooleanAttributes: false,
});

const ensureArray = <T>(value: T | T[] | undefined): T[] => {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>(
        (acc, key) => ({
          ...acc,
          [key]: sortKeysDeep((value as Record<string, unknown>)[key]),
        }),
        {}
      );
  }

  return value;
};

const stableStringify = (value: unknown): string => JSON.stringify(sortKeysDeep(value));

const toMap = (items: Array<Record<string, unknown>>, rule: XmlKeyRule): Map<string, Record<string, unknown>> =>
  new Map(items.map((item) => [rule.keySelector(item), item]));

const buildRoot = (rootName: string, attributes: Record<string, unknown>, content: Record<string, unknown>): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ [rootName]: { ...attributes, ...content } })}`;

export type XmlDiffResult = {
  packageXml?: string;
  destructiveXml?: string;
  hasChanges: boolean;
  hasDeletes: boolean;
};

export const diffCompositeXml = (
  oldXml: string,
  newXml: string,
  rootName: string,
  rules: XmlCollectionRules,
  alwaysInclude: string[] = []
): XmlDiffResult => {
  const oldParsed = parser.parse(oldXml) as Record<string, Record<string, unknown>>;
  const newParsed = parser.parse(newXml) as Record<string, Record<string, unknown>>;

  const oldRoot = oldParsed[rootName] ?? {};
  const newRoot = newParsed[rootName] ?? {};
  const rootAttributes = Object.fromEntries(Object.entries(newRoot).filter(([key]) => key.startsWith('@_')));

  const packageContent: Record<string, unknown> = {};
  const destructiveContent: Record<string, unknown> = {};
  let hasPackageChanges = false;
  let hasDeletes = false;

  for (const fieldName of alwaysInclude) {
    if (newRoot[fieldName] !== undefined) {
      packageContent[fieldName] = newRoot[fieldName];
    }
  }

  for (const [fieldName, rule] of Object.entries(rules)) {
    const oldItems = ensureArray(
      oldRoot[fieldName] as Record<string, unknown> | Array<Record<string, unknown>> | undefined
    );
    const newItems = ensureArray(
      newRoot[fieldName] as Record<string, unknown> | Array<Record<string, unknown>> | undefined
    );
    const oldMap = toMap(oldItems, rule);
    const newMap = toMap(newItems, rule);

    const changedItems = newItems.filter((item) => {
      const key = rule.keySelector(item);
      const previous = oldMap.get(key);
      return !previous || stableStringify(previous) !== stableStringify(item);
    });

    if (changedItems.length > 0) {
      packageContent[fieldName] = changedItems;
      hasPackageChanges = true;
    }

    if (rule.supportsDelete) {
      const deletedItems = oldItems.filter((item) => !newMap.has(rule.keySelector(item)));
      if (deletedItems.length > 0) {
        destructiveContent[fieldName] = deletedItems;
        hasDeletes = true;
      }
    }
  }

  for (const [fieldName, value] of Object.entries(newRoot)) {
    if (fieldName.startsWith('@_') || fieldName in rules || alwaysInclude.includes(fieldName)) {
      continue;
    }

    const oldValue = oldRoot[fieldName];
    if (stableStringify(oldValue) !== stableStringify(value)) {
      packageContent[fieldName] = value;
      hasPackageChanges = true;
    }
  }

  return {
    packageXml: hasPackageChanges ? buildRoot(rootName, rootAttributes, packageContent) : undefined,
    destructiveXml: hasDeletes ? buildRoot(rootName, rootAttributes, destructiveContent) : undefined,
    hasChanges: hasPackageChanges,
    hasDeletes,
  };
};
