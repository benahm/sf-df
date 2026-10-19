import path from 'node:path';

import { MetadataResolver, type SourceComponent, registry } from '@salesforce/source-deploy-retrieve';

import { pathExists } from './fs.js';
import type { ManifestEntry, ResolvedMetadataComponent, SnapshotRef } from './types.js';

const metadataResolver = new MetadataResolver();

// SDR throws on files that are not metadata (.gitkeep, README.md, jsconfig.json...): they must not abort the
// whole delta, so they resolve to nothing and the caller reports them.
const resolveComponents = (absolutePath: string): SourceComponent[] => {
  try {
    return metadataResolver.getComponentsFromPath(absolutePath);
  } catch {
    return [];
  }
};

type RegistryType = (typeof registry)['types'][string];

const BUNDLE_DIRECTORIES = new Set(['aura', 'lwc', 'experiences']);

const toRelativeSourcePath = (snapshot: SnapshotRef, absolutePath: string): string =>
  path.relative(snapshot.sourceDirAbs, absolutePath).replaceAll(path.sep, '/');

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const isWithinSourceDir = (snapshot: SnapshotRef, absolutePath: string): boolean => {
  const relativePath = path.relative(snapshot.sourceDirAbs, absolutePath);
  return relativePath !== '' && !relativePath.startsWith('..');
};

const chooseComponent = (components: SourceComponent[], absolutePath: string): SourceComponent | undefined => {
  const normalizedPath = absolutePath.replaceAll(path.sep, '/');

  return (
    components.find((component) => {
      const contentPaths = component.walkContent().map((entry) => entry.replaceAll(path.sep, '/'));
      return contentPaths.includes(normalizedPath) || component.xml?.replaceAll(path.sep, '/') === normalizedPath;
    }) ?? components[0]
  );
};

const getManifestEntry = (component: SourceComponent): ManifestEntry | undefined => {
  if (component.isAddressable) {
    return { type: component.type.name, fullName: component.fullName };
  }

  if (component.parent) {
    return { type: component.parent.type.name, fullName: component.parent.fullName };
  }

  return undefined;
};

const stripKnownSuffix = (fileName: string, type: RegistryType): string => {
  const metaFileSuffix = type.metaFileSuffix ?? '-meta.xml';
  const suffixes = unique(
    [
      type.suffix ? `.${type.suffix}${metaFileSuffix}` : undefined,
      `${metaFileSuffix}`,
      type.suffix ? `.${type.suffix}` : undefined,
    ].filter((value): value is string => Boolean(value))
  );

  for (const suffix of suffixes.sort((left, right) => right.length - left.length)) {
    if (fileName.endsWith(suffix)) {
      return fileName.slice(0, -suffix.length);
    }
  }

  return fileName;
};

const getTypeByDirectoryName = (directoryName: string): RegistryType | undefined =>
  Object.values(registry.types).find((type) => type.directoryName === directoryName);

const resolveBundleRoot = (relativePath: string): string => {
  const segments = relativePath.split('/');
  return segments.slice(0, 2).join('/');
};

const buildFallbackResolution = (
  snapshot: SnapshotRef,
  relativePath: string
): ResolvedMetadataComponent | undefined => {
  // This keeps manifest generation working even when SDR cannot resolve a deleted path from a temp snapshot.
  const sourceRelativePath = relativePath.replaceAll('\\', '/');
  const [directoryName, ...rest] = sourceRelativePath.split('/');
  const type = getTypeByDirectoryName(directoryName);

  if (!type || rest.length === 0) {
    return undefined;
  }

  if (BUNDLE_DIRECTORIES.has(directoryName)) {
    const bundleName = rest[0];
    const rootRelativePath = `${snapshot.sourceDir}/${resolveBundleRoot(sourceRelativePath)}`;
    return {
      typeName: type.name,
      fullName: bundleName,
      rootRelativePath,
      contentRelativePaths: [rootRelativePath],
      isAddressable: true,
    };
  }

  if (directoryName === 'staticresources') {
    const resourceName = rest[0].includes('.') ? stripKnownSuffix(rest[0], type) : rest[0];
    const rootRelativePath = `${snapshot.sourceDir}/staticresources/${resourceName}`;
    const metaRelativePath = `${snapshot.sourceDir}/staticresources/${resourceName}.resource-meta.xml`;
    return {
      typeName: type.name,
      fullName: resourceName,
      rootRelativePath,
      xmlRelativePath: metaRelativePath,
      contentRelativePaths: [rootRelativePath, metaRelativePath],
      isAddressable: true,
    };
  }

  const fileName = rest.at(-1) ?? rest[0];
  const fullName = type.ignoreParsedFullName ? type.name : stripKnownSuffix(fileName, type);
  const rootRelativePath = `${snapshot.sourceDir}/${directoryName}/${fileName}`;

  return {
    typeName: type.name,
    fullName,
    rootRelativePath,
    xmlRelativePath: rootRelativePath.endsWith('.xml') ? rootRelativePath : undefined,
    contentRelativePaths: [rootRelativePath],
    isAddressable: true,
  };
};

const toResolvedComponent = (
  snapshot: SnapshotRef,
  relativePath: string,
  component: SourceComponent
): ResolvedMetadataComponent => {
  const contentRelativePaths = unique(
    [...component.walkContent(), component.xml, component.content]
      .filter((entry): entry is string => Boolean(entry))
      .filter((entry) => isWithinSourceDir(snapshot, entry))
      .map((entry) => `${snapshot.sourceDir}/${toRelativeSourcePath(snapshot, entry)}`)
  );

  const rootPath = contentRelativePaths[0] ?? relativePath;

  return {
    typeName: component.type.name,
    fullName: component.fullName,
    rootRelativePath: rootPath,
    xmlRelativePath: component.xml
      ? `${snapshot.sourceDir}/${toRelativeSourcePath(snapshot, component.xml)}`
      : undefined,
    contentRelativePaths,
    component,
    isAddressable: component.isAddressable,
  };
};

// Resolves a path with SDR once, for both the component and its package.xml entry: SDR resolution is the costly
// part of a delta (it walks up the folders of every file).
export const resolvePath = async (
  snapshot: SnapshotRef,
  relativePath: string
): Promise<{ resolvedMetadata?: ResolvedMetadataComponent; manifestEntry?: ManifestEntry }> => {
  const absolutePath = path.join(snapshot.rootDir, relativePath);

  if (!(await pathExists(absolutePath))) {
    const fallback = buildFallbackResolution(snapshot, relativePath.replace(`${snapshot.sourceDir}/`, ''));
    return {
      resolvedMetadata: fallback,
      manifestEntry: fallback ? { type: fallback.typeName, fullName: fallback.fullName } : undefined,
    };
  }

  // A file SDR does not recognise is not metadata (or is forceignored): guessing a type from its folder
  // would turn lwc/jsconfig.json into a bogus LightningComponentBundle.
  const component = chooseComponent(resolveComponents(absolutePath), absolutePath);
  if (!component) {
    return {};
  }

  return { resolvedMetadata: toResolvedComponent(snapshot, relativePath, component), manifestEntry: getManifestEntry(component) };
};
