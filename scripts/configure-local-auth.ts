import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { parse } from 'dotenv';

const localAuthDefaults: Readonly<Record<string, string>> = {
  AUTH_DB_POOL_MAX: '5',
  AUTH_TOKEN_ISSUER: 'dokana-backend',
  AUTH_TOKEN_AUDIENCE: 'dokana-mobile',
  AUTH_ACCESS_TOKEN_ACTIVE_KID: 'local-v1',
  AUTH_ACCESS_TOKEN_PREVIOUS_KEYS: '{}',
  AUTH_ACCESS_TOKEN_TTL_SECONDS: '900',
  AUTH_REFRESH_TOKEN_TTL_SECONDS: '2592000',
  AUTH_SESSION_TTL_SECONDS: '2592000',
};

function setEnvironmentVariable(
  contents: string,
  name: string,
  value: string,
  replaceExisting = false,
): string {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = contents.endsWith('\n');
  const lines = contents.split(/\r?\n/);
  if (hasTrailingNewline) {
    lines.pop();
  }

  const matcher = new RegExp(`^(?:export\\s+)?${name}\\s*=`);
  const matchingIndexes = lines.flatMap((line, index) => (matcher.test(line) ? [index] : []));
  if (matchingIndexes.length > 1) {
    throw new Error(`The local environment contains duplicate ${name} entries.`);
  }

  const existingIndex = matchingIndexes[0];
  if (existingIndex !== undefined) {
    if (!replaceExisting) {
      return contents;
    }
    lines[existingIndex] = `${name}=${value}`;
  } else {
    lines.push(`${name}=${value}`);
  }

  return `${lines.join(newline)}${newline}`;
}

function isStrongSigningSecret(value: string | undefined): boolean {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, 'base64url').byteLength >= 32
  );
}

export function configureLocalAuthenticationEnvironment(
  contents: string,
  createSigningSecret: () => string = () => randomBytes(32).toString('base64url'),
): string {
  let updatedContents = contents;
  for (const [name, value] of Object.entries(localAuthDefaults)) {
    updatedContents = setEnvironmentVariable(updatedContents, name, value);
  }

  const configuredSecret = parse(updatedContents).AUTH_ACCESS_TOKEN_ACTIVE_SECRET;
  if (!isStrongSigningSecret(configuredSecret)) {
    updatedContents = setEnvironmentVariable(
      updatedContents,
      'AUTH_ACCESS_TOKEN_ACTIVE_SECRET',
      createSigningSecret(),
      true,
    );
  }

  return updatedContents;
}

async function replaceEnvironmentFile(path: string, contents: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.env.auth-${String(process.pid)}-${randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function main(): Promise<void> {
  const environmentPath = resolve(__dirname, '..', '.env');
  const originalContents = await readFile(environmentPath, 'utf8');
  const currentEnvironment = parse(originalContents);

  if (!currentEnvironment.AUTH_DATABASE_URL) {
    throw new Error('AUTH_DATABASE_URL must be provisioned before auth configuration.');
  }

  const updatedContents = configureLocalAuthenticationEnvironment(originalContents);

  if (updatedContents !== originalContents) {
    await replaceEnvironmentFile(environmentPath, updatedContents);
  }

  process.stdout.write('Local authentication environment: OK (required names configured).\n');
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown configuration failure.';
    process.stderr.write(`Local authentication environment: FAIL (${message})\n`);
    process.exitCode = 1;
  });
}
