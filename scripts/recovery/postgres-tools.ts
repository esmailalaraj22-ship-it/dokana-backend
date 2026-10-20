import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

const TOOL_OUTPUT_MAXIMUM_BYTES = 8 * 1024 * 1024;

export interface PostgresToolchain {
  pgDump: string;
  pgRestore: string;
}

export async function resolvePostgresToolchain(binDirectory?: string): Promise<PostgresToolchain> {
  return {
    pgDump: await resolveTool('pg_dump', binDirectory),
    pgRestore: await resolveTool('pg_restore', binDirectory),
  };
}

export async function readPgDumpVersion(toolchain: PostgresToolchain): Promise<string> {
  const result = await runTool(toolchain.pgDump, ['--version'], process.env);
  const version = result.stdout.trim();
  if (!version || version.length > 256) throw new Error('PostgreSQL backup tool is invalid.');
  return version;
}

export async function createCustomFormatDump(
  toolchain: PostgresToolchain,
  connectionString: string,
  targetPath: string,
  snapshotId?: string,
): Promise<void> {
  const snapshotArguments = snapshotId ? ['--snapshot', snapshotId] : [];
  await runTool(
    toolchain.pgDump,
    ['--format=custom', '--file', targetPath, '--no-password', ...snapshotArguments],
    postgresEnvironment(connectionString),
  );
}

export async function listCustomFormatDump(
  toolchain: PostgresToolchain,
  artifactPath: string,
): Promise<string> {
  const result = await runTool(toolchain.pgRestore, ['--list', artifactPath], process.env);
  return result.stdout;
}

export async function restoreCustomFormatDump(
  toolchain: PostgresToolchain,
  connectionString: string,
  artifactPath: string,
): Promise<void> {
  const environment = postgresEnvironment(connectionString);
  const database = databaseName(connectionString);
  for (const section of ['pre-data', 'post-data'] as const) {
    await runTool(
      toolchain.pgRestore,
      [
        '--exit-on-error',
        '--no-password',
        '--section',
        section,
        '--dbname',
        database,
        artifactPath,
      ],
      environment,
    );
  }
  await runTool(
    toolchain.pgRestore,
    [
      '--exit-on-error',
      '--no-password',
      '--section',
      'data',
      '--disable-triggers',
      '--dbname',
      database,
      artifactPath,
    ],
    environment,
  );
}

export function assertCompleteDokanaArchiveList(value: string): void {
  for (const schema of ['platform', 'ledger', 'sync', 'audit']) {
    if (!new RegExp(`\\bSCHEMA\\b[^\\n]*\\b${schema}\\b`, 'i').test(value)) {
      throw new Error('PostgreSQL backup archive is missing a required schema.');
    }
  }
  for (const required of ['schema_migrations', 'POLICY', 'FUNCTION', 'TRIGGER']) {
    if (!value.includes(required)) {
      throw new Error('PostgreSQL backup archive is missing required platform structure.');
    }
  }
}

function postgresEnvironment(connectionString: string): NodeJS.ProcessEnv {
  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Recovery database connection must use PostgreSQL.');
  }
  const sslMode =
    parsed.searchParams.get('sslmode') ??
    (process.env.DATABASE_SSL_MODE === 'verify-full'
      ? 'verify-full'
      : process.env.DATABASE_SSL_MODE === 'disable'
        ? 'disable'
        : null);
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGDATABASE: databaseName(connectionString),
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    ...(sslMode ? { PGSSLMODE: sslMode } : {}),
  };
}

function databaseName(connectionString: string): string {
  const name = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  if (!name) throw new Error('Recovery database name is missing.');
  return name;
}

async function resolveTool(name: 'pg_dump' | 'pg_restore', binDirectory?: string): Promise<string> {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    ...(binDirectory ? [join(binDirectory, `${name}${suffix}`)] : []),
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => join(entry, `${name}${suffix}`)),
    ...(process.platform === 'win32'
      ? ['18', '17', '16', '15'].map((version) =>
          join('C:\\Program Files\\PostgreSQL', version, 'bin', `${name}.exe`),
        )
      : []),
  ];
  for (const candidate of candidates) {
    if (
      await access(candidate)
        .then(() => true)
        .catch(() => false)
    )
      return candidate;
  }
  throw new Error('Required PostgreSQL backup toolchain is unavailable.');
}

function runTool(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const collect = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > TOOL_OUTPUT_MAXIMUM_BYTES) child.kill();
      else stdout.push(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > TOOL_OUTPUT_MAXIMUM_BYTES) child.kill();
      else stderr.push(chunk);
    });
    child.once('error', () => reject(new Error('PostgreSQL backup tool could not start.')));
    child.once('close', (code) => {
      if (code !== 0 || outputBytes > TOOL_OUTPUT_MAXIMUM_BYTES) {
        reject(new Error(classifyToolFailure(Buffer.concat(stderr).toString('utf8'))));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout).toString('utf8') });
    });
  });
}

function classifyToolFailure(stderr: string): string {
  if (/server version:.*pg_dump version:/is.test(stderr)) {
    return 'PostgreSQL backup tool version is incompatible with the server.';
  }
  if (/password authentication failed|no password supplied/is.test(stderr)) {
    return 'PostgreSQL backup authentication failed.';
  }
  if (/permission denied|must be superuser/is.test(stderr)) {
    return 'PostgreSQL backup role lacks required privileges.';
  }
  if (/could not connect|connection .*failed|connection refused/is.test(stderr)) {
    return 'PostgreSQL backup connection failed.';
  }
  return 'PostgreSQL backup tool failed.';
}
