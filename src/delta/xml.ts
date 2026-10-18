import { XMLBuilder, XMLParser } from 'fast-xml-parser';

export type XmlKeyRule = {
  keySelector: (item: Record<string, unknown>) => string;
  supportsDelete?: boolean;
  // Child metadata type addressed by destructiveChanges.xml when an item of this collection is deleted.
  childType?: string;
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

// Text of a parsed element, for building collection keys. Values are strings because tag values are not parsed;
// a nested element is serialised rather than turned into "[object Object]".
export const textOf = (value: unknown): string =>
  typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);

// Rules for collections identified by one or more child elements; a key made of several elements joins them
// with "::".
export const keyedCollectionRules = (keys: Record<string, string[]>): XmlCollectionRules =>
  Object.fromEntries(
    Object.entries(keys).map(([fieldName, keyFields]) => [
      fieldName,
      { keySelector: (item: Record<string, unknown>) => keyFields.map((keyField) => textOf(item[keyField])).join('::') },
    ])
  );

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
    return Object.keys(value)
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

// Rewrites one top-level element and keeps everything else, e.g. to deploy a component as inactive.
export const setRootValue = (xml: string, rootName: string, fieldName: string, value: string): string => {
  const parsed = parser.parse(xml) as Record<string, Record<string, unknown>>;
  const root = parsed[rootName] ?? {};
  const attributes = Object.fromEntries(Object.entries(root).filter(([key]) => key.startsWith('@_')));
  const content = Object.fromEntries(Object.entries(root).filter(([key]) => !key.startsWith('@_')));
  return buildRoot(rootName, attributes, { ...content, [fieldName]: value });
};

export type XmlDiffResult = {
  packageXml?: string;
  destructiveXml?: string;
  deletedItems: Array<{ fieldName: string; key: string }>;
  hasChanges: boolean;
  hasDeletes: boolean;
};

// `lead` is the text between the previous element (or the root opening tag) and this one: indentation, and the
// comments that sit between top-level elements.
export type XmlChunk = { tag: string; raw: string; lead: string };
// `tail` is the text between the last element and the root closing tag.
export type XmlChunks = { prolog: string; rootOpen: string; rootClose: string; tail: string; items: XmlChunk[] };

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g;

// Whitespace between tags is not significant (the parser trims values), so it is ignored when comparing.
export const normalizeChunk = (raw: string): string => raw.replace(/>\s+</g, '><').trim();

// Splits a metadata file into its top-level elements without building a DOM. Returns undefined when the
// document does not have the expected shape, so callers fall back to a full parse.
export const splitTopLevel = (xml: string): XmlChunks | undefined => {
  let depth = 0;
  let rootOpenEnd = -1;
  let rootStart = -1;
  let itemStart = -1;
  let itemTag = '';
  let previousEnd = -1;
  const items: XmlChunks['items'] = [];

  for (const match of xml.matchAll(TOKEN)) {
    const [token, closing, tag, selfClosing] = match;
    if (!tag) {
      continue;
    }

    const index = match.index;
    if (closing) {
      depth -= 1;
      if (depth === 1) {
        items.push({ tag: itemTag, raw: xml.slice(itemStart, index + token.length), lead: xml.slice(previousEnd, itemStart) });
        previousEnd = index + token.length;
      } else if (depth === 0) {
        return {
          prolog: xml.slice(0, rootStart),
          rootOpen: xml.slice(rootStart, rootOpenEnd),
          rootClose: xml.slice(index),
          tail: xml.slice(previousEnd, index),
          items,
        };
      }
    } else if (depth === 0) {
      rootStart = index;
      rootOpenEnd = index + token.length;
      previousEnd = rootOpenEnd;
      depth = selfClosing ? 0 : 1;
    } else {
      if (depth === 1) {
        itemStart = index;
        itemTag = tag;
        if (selfClosing) {
          items.push({ tag, raw: token, lead: xml.slice(previousEnd, index) });
          previousEnd = index + token.length;
          continue;
        }
      }

      if (!selfClosing) {
        depth += 1;
      }
    }
  }

  return undefined;
};

// Raw (still escaped) text of a direct child element, e.g. the <field> of a <fieldPermissions>. Nested
// elements with the same name are skipped. Returns undefined when the child is missing.
export const childElementText = (raw: string, childName: string): string | undefined => {
  // Fast path: the first <childName> is a direct child when everything before it, inside the parent, is balanced.
  const open = `<${childName}>`;
  const start = raw.indexOf(open);
  const parentOpenEnd = raw.indexOf('>') + 1;
  if (start > 0) {
    const before = raw.slice(parentOpenEnd, start);
    const end = raw.indexOf(`</${childName}>`, start);
    if (end > 0 && !before.includes('<!') && !before.includes('<?') && !raw.slice(start + open.length, end).includes('<')) {
      const opened = before.split('<').length - 1;
      const closed = before.split('</').length - 1;
      const selfClosed = before.split('/>').length - 1;
      if (opened - closed - selfClosed === closed) {
        return raw.slice(start + open.length, end);
      }
    }
  }

  let depth = 0;
  let valueStart = -1;

  for (const match of raw.matchAll(TOKEN)) {
    const [token, closing, tag, selfClosing] = match;
    if (!tag) {
      continue;
    }

    if (closing) {
      depth -= 1;
      if (depth === 1 && valueStart >= 0 && tag === childName) {
        return raw.slice(valueStart, match.index);
      }
    } else if (selfClosing) {
      if (depth === 1 && tag === childName) {
        return '';
      }
    } else {
      if (depth === 1 && tag === childName) {
        valueStart = match.index + token.length;
      }

      depth += 1;
    }
  }

  return undefined;
};

// Big Profiles and Translations differ by a handful of elements: everything that is textually identical on
// both sides is dropped before parsing, so only the differing elements go through the XML parser. Collections
// without a key rule are compared as a whole, so they are kept entirely as soon as one element differs.
const keepDifferingElements = (
  oldXml: string,
  newXml: string,
  rules: XmlCollectionRules,
  alwaysInclude: string[]
): [string, string] => {
  const oldChunks = splitTopLevel(oldXml);
  const newChunks = splitTopLevel(newXml);
  if (!oldChunks || !newChunks) {
    return [oldXml, newXml];
  }

  // Both sides usually share the same formatting, so exact text is compared first; only the leftovers are
  // compared again without the whitespace between tags.
  const differingItems = (items: XmlChunk[], others: XmlChunk[]): Set<XmlChunk> => {
    const otherRaw = new Set(others.map((item) => item.raw));
    const unmatched = items.filter((item) => !otherRaw.has(item.raw));
    if (unmatched.length === 0) {
      return new Set();
    }

    const ownRaw = new Set(items.map((item) => item.raw));
    const otherNormalized = new Set(
      others.filter((item) => !ownRaw.has(item.raw)).map((item) => normalizeChunk(item.raw))
    );
    return new Set(unmatched.filter((item) => !otherNormalized.has(normalizeChunk(item.raw))));
  };

  const oldDiffering = differingItems(oldChunks.items, newChunks.items);
  const newDiffering = differingItems(newChunks.items, oldChunks.items);
  const changedUnkeyedTags = new Set(
    [...oldDiffering, ...newDiffering].map((item) => item.tag).filter((tag) => !(tag in rules))
  );
  const keep =
    (differing: Set<XmlChunk>) =>
    (item: XmlChunk): boolean =>
    alwaysInclude.includes(item.tag) || changedUnkeyedTags.has(item.tag) || differing.has(item);
  const rebuild = (chunks: XmlChunks, kept: XmlChunk[]): string =>
    `${chunks.prolog}${chunks.rootOpen}${kept.map((item) => item.raw).join('')}${chunks.rootClose}`;

  return [
    rebuild(oldChunks, oldChunks.items.filter(keep(oldDiffering))),
    rebuild(newChunks, newChunks.items.filter(keep(newDiffering))),
  ];
};

export const diffCompositeXml = (
  oldXml: string,
  newXml: string,
  rootName: string,
  rules: XmlCollectionRules,
  alwaysInclude: string[] = []
): XmlDiffResult => {
  const [oldReduced, newReduced] = keepDifferingElements(oldXml, newXml, rules, alwaysInclude);
  const oldParsed = parser.parse(oldReduced) as Record<string, Record<string, unknown>>;
  const newParsed = parser.parse(newReduced) as Record<string, Record<string, unknown>>;

  const oldRoot = oldParsed[rootName] ?? {};
  const newRoot = newParsed[rootName] ?? {};
  const rootAttributes = Object.fromEntries(Object.entries(newRoot).filter(([key]) => key.startsWith('@_')));

  const packageContent: Record<string, unknown> = {};
  const destructiveContent: Record<string, unknown> = {};
  const deletedKeys: XmlDiffResult['deletedItems'] = [];
  let hasPackageChanges = false;
  let hasDeletes = false;

  for (const fieldName of alwaysInclude) {
    const newValue = newRoot[fieldName];
    if (newValue !== undefined) {
      packageContent[fieldName] = newValue;
    }

    if (stableStringify(oldRoot[fieldName]) !== stableStringify(newValue)) {
      hasPackageChanges = true;
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
        deletedKeys.push(...deletedItems.map((item) => ({ fieldName, key: rule.keySelector(item) })));
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
    deletedItems: deletedKeys,
    hasChanges: hasPackageChanges,
    hasDeletes,
  };
};
