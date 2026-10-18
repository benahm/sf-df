import { childElementText, normalizeChunk, splitTopLevel, type XmlChunk, type XmlChunks } from '../delta/xml.js';
import { mergeKeysFor, type MergeKeys } from './merge-rules.js';

export type XmlMergeOptions = {
  markerSize?: number;
  labels?: { ours: string; theirs: string };
};

export type XmlMergeResult = { content: string; conflicts: number };

// One mergeable item: a keyed element (a fieldPermissions of a field), or every element of an unkeyed tag.
type Unit = { id: string; lead: string; raw: string };
type Entry = { id: string; lead: string; raw: string } | { id: string; conflict: { ours?: Unit; theirs?: Unit } };
type Side = { header: string; units: Unit[]; byId: Map<string, Unit> };

const rootNameOf = (rootOpen: string): string | undefined => /^<([\w:.-]+)/.exec(rootOpen)?.[1];
const tagOf = (id: string): string => id.split('\0')[0];

// Returns undefined when two items share a key: the file can't be merged by key.
const toUnits = (chunks: XmlChunk[], keys: MergeKeys): Unit[] | undefined => {
  const units: Unit[] = [];
  const byId = new Map<string, Unit>();

  for (const chunk of chunks) {
    const keyFields = keys[chunk.tag];
    const id = keyFields
      ? [chunk.tag, ...keyFields.map((keyField) => childElementText(chunk.raw, keyField) ?? '')].join('\0')
      : chunk.tag;
    const existing = byId.get(id);
    if (existing && keyFields) {
      return undefined;
    }

    if (existing) {
      existing.raw += chunk.lead + chunk.raw;
      continue;
    }

    const unit = { id, lead: chunk.lead, raw: chunk.raw };
    byId.set(id, unit);
    units.push(unit);
  }

  return units;
};

const toSide = (chunks: XmlChunks, keys: MergeKeys): Side | undefined => {
  const units = toUnits(chunks.items, keys);
  return units && { header: chunks.prolog + chunks.rootOpen, units, byId: new Map(units.map((unit) => [unit.id, unit])) };
};

// Whitespace between tags is not significant. Most items are textually identical, so normalising is rarely needed.
const same = (left: Unit | undefined, right: Unit | undefined): boolean =>
  left !== undefined &&
  right !== undefined &&
  (left.raw === right.raw || normalizeChunk(left.raw) === normalizeChunk(right.raw));

// Three-way merge of a whole text: undefined when both sides changed it differently.
const mergeText = (base: string | undefined, ours: string, theirs: string): string | undefined => {
  const [normBase, normOurs, normTheirs] = [base, ours, theirs].map((text) => text && normalizeChunk(text));
  if (normOurs === normTheirs || normTheirs === normBase) {
    return ours;
  }

  return normOurs === normBase ? theirs : undefined;
};

// Ours gives the order: each of its items is kept, replaced by theirs, dropped or put in conflict.
const mergeOursItems = (base: Side, ours: Side, theirs: Side): Entry[] =>
  ours.units.flatMap((unit): Entry[] => {
    const baseUnit = base.byId.get(unit.id);
    const theirsUnit = theirs.byId.get(unit.id);

    if (!theirsUnit) {
      // Added by ours only, or deleted by theirs.
      if (!baseUnit) {
        return [unit];
      }

      return same(unit, baseUnit) ? [] : [{ id: unit.id, conflict: { ours: unit } }];
    }

    if (same(unit, theirsUnit) || same(theirsUnit, baseUnit)) {
      return [unit];
    }

    return same(unit, baseUnit)
      ? [{ id: unit.id, lead: unit.lead, raw: theirsUnit.raw }]
      : [{ id: unit.id, conflict: { ours: unit, theirs: theirsUnit } }];
  });

// Items that ours doesn't hold go right after the item that precedes them in theirs. Items added by ours at the
// same place are skipped while they sort before them, so that two sorted files (as retrieved from Salesforce)
// give a sorted file.
// Insertions are collected per slot of ours (before[i] goes before entries[i]) so that a branch adding thousands of
// items to a big profile stays linear.
const insertTheirsItems = (entries: Entry[], base: Side, theirs: Side): Entry[] => {
  const positions = new Map(entries.map((entry, index) => [entry.id, index]));
  const before: Entry[][] = Array.from({ length: entries.length + 1 }, () => []);
  let slot = 0;

  for (const unit of theirs.units) {
    const position = positions.get(unit.id);
    if (position !== undefined) {
      slot = position + 1;
      continue;
    }

    // Added by theirs, or deleted by ours: kept deleted unless theirs changed it.
    const baseUnit = base.byId.get(unit.id);
    if (same(baseUnit, unit)) {
      continue;
    }

    const isOursAdditionBefore = (entry: Entry | undefined): boolean =>
      entry !== undefined && !theirs.byId.has(entry.id) && tagOf(entry.id) === tagOf(unit.id) && entry.id < unit.id;
    while (isOursAdditionBefore(entries[slot])) {
      slot += 1;
    }

    before[slot].push(baseUnit ? { id: unit.id, conflict: { theirs: unit } } : unit);
  }

  return before.flatMap((inserted, index) => (index < entries.length ? [...inserted, entries[index]] : inserted));
};

const render = (entries: Entry[], eol: string, options: XmlMergeOptions): { body: string; conflicts: number } => {
  const markerSize = options.markerSize ?? 7;
  const labels = options.labels ?? { ours: 'ours', theirs: 'theirs' };
  const side = (unit?: Unit): string =>
    unit ? (unit.lead.includes('\n') ? unit.lead : `${eol}${unit.lead}`) + unit.raw : '';
  let conflicts = 0;

  const body = entries
    .map((entry) => {
      if (!('conflict' in entry)) {
        return entry.lead + entry.raw;
      }

      conflicts += 1;
      return [
        `${eol}${'<'.repeat(markerSize)} ${labels.ours}${side(entry.conflict.ours)}`,
        `${eol}${'='.repeat(markerSize)}${side(entry.conflict.theirs)}`,
        `${eol}${'>'.repeat(markerSize)} ${labels.theirs}`,
      ].join('');
    })
    .join('');

  return { body, conflicts };
};

// The three versions split into items, or undefined when one of them can't be merged by key.
const parseSides = (
  baseXml: string,
  oursChunks: XmlChunks,
  theirsXml: string
): { base?: Side; ours: Side; theirs: Side } | undefined => {
  const theirsChunks = splitTopLevel(theirsXml);
  // An empty ancestor means the file was added on both sides.
  const baseChunks = baseXml.trim() === '' ? undefined : splitTopLevel(baseXml);
  if (!theirsChunks || (!baseChunks && baseXml.trim() !== '')) {
    return undefined;
  }

  const rootName = rootNameOf(oursChunks.rootOpen);
  const keys = rootName ? mergeKeysFor(rootName) : undefined;
  const others = baseChunks ? [theirsChunks, baseChunks] : [theirsChunks];
  if (!keys || others.some((chunks) => rootNameOf(chunks.rootOpen) !== rootName)) {
    return undefined;
  }

  const ours = toSide(oursChunks, keys);
  const theirs = toSide(theirsChunks, keys);
  const base = baseChunks && toSide(baseChunks, keys);
  if (!ours || !theirs || (baseChunks && !base)) {
    return undefined;
  }

  return { base, ours, theirs };
};

const EMPTY_SIDE: Side = { header: '', units: [], byId: new Map() };
const CONFLICT_MARKER = /^(?:<{7,}|={7,}|>{7,})(?:[ \r]|$)/m;

// Merges two versions of a container metadata file (Profile, CustomLabels, Translations...) element by element,
// using the key of each item (the field of a fieldPermissions, the fullName of a label): two branches that touch
// different items of the same file never conflict, even when the items are next to each other.
//
// Returns undefined when the file can't be merged by key (not a known container type, not well-formed, duplicate
// keys, both sides changed the root element): the caller falls back to a line merge.
export const mergeMetadataXml = (
  baseXml: string,
  oursXml: string,
  theirsXml: string,
  options: XmlMergeOptions = {}
): XmlMergeResult | undefined => {
  // Markers sit between elements, where the splitter takes them for indentation.
  if ([baseXml, oursXml, theirsXml].some((xml) => CONFLICT_MARKER.test(xml))) {
    return undefined;
  }

  // Items taken from theirs get the line endings of ours.
  const eol = oursXml.includes('\r\n') ? '\r\n' : '\n';
  const withEol = (xml: string): string => (xml.includes('\r\n') === (eol === '\r\n') ? xml : xml.replace(/\r?\n/g, eol));
  const oursChunks = splitTopLevel(oursXml);
  const sides = oursChunks && parseSides(withEol(baseXml), oursChunks, withEol(theirsXml));
  if (!oursChunks || !sides) {
    return undefined;
  }

  const { ours, theirs, base = EMPTY_SIDE } = sides;
  const header = mergeText(sides.base?.header, ours.header, theirs.header);
  if (header === undefined) {
    return undefined;
  }

  const entries = insertTheirsItems(mergeOursItems(base, ours, theirs), base, theirs);
  const { body, conflicts } = render(entries, eol, options);

  return { content: `${header}${body}${oursChunks.tail}${oursChunks.rootClose}`, conflicts };
};
