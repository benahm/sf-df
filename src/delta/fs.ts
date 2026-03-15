import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ensureDir = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
};

export const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
};

export const copyFileInto = async (
  absoluteSourcePath: string,
  relativeDestinationPath: string,
  outputRoot: string
): Promise<void> => {
  const destinationPath = path.join(outputRoot, relativeDestinationPath);
  await ensureDir(path.dirname(destinationPath));
  const content = await readFile(absoluteSourcePath);
  await writeFile(destinationPath, content);
};

export const collectFilesRecursively = async (rootDir: string): Promise<string[]> => {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return collectFilesRecursively(absolutePath);
      }

      return [absolutePath];
    })
  );

  return files.flat();
};
