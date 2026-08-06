import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

export interface MigrationFile {
  filename: string;
  absolutePath: string;
  contents: string;
  checksumSha256: string;
}

const migrationFilenamePattern = /^[0-9]{4}_[a-z0-9_]+\.sql$/;

export function migrationsDirectory(): string {
  return resolve(__dirname, '..', '..', 'database', 'migrations');
}

export function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

export async function readMigrationFile(filename: string): Promise<MigrationFile> {
  if (basename(filename) !== filename || !migrationFilenamePattern.test(filename)) {
    throw new Error('Invalid migration filename.');
  }

  const absolutePath = resolve(migrationsDirectory(), filename);
  const contents = await readFile(absolutePath, 'utf8');

  return {
    filename,
    absolutePath,
    contents,
    checksumSha256: sha256(contents),
  };
}

export async function readMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDirectory(), { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && migrationFilenamePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));

  if (filenames.length === 0) {
    throw new Error('No versioned database migrations were found.');
  }

  const duplicatePrefixes = filenames.filter(
    (filename, index) => index > 0 && filename.slice(0, 4) === filenames[index - 1]?.slice(0, 4),
  );
  if (duplicatePrefixes.length > 0) {
    throw new Error('Migration numeric prefixes must be unique.');
  }

  return Promise.all(filenames.map(readMigrationFile));
}
