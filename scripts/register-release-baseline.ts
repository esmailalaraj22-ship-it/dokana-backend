import { resolve } from 'node:path';

import { createMigrationPool, requiredPostgresUrl } from './migrations/migration-database';
import {
  readReleaseBaselineRegistrationInput,
  registerReleaseBaseline,
} from './migrations/release-baseline-provenance';

async function main(): Promise<void> {
  if (process.argv.length !== 3 || !process.argv[2]) {
    throw new Error('Expected one release baseline provenance document path.');
  }
  const input = await readReleaseBaselineRegistrationInput(resolve(process.argv[2]));
  const pool = createMigrationPool(
    requiredPostgresUrl('DATABASE_MIGRATION_URL'),
    'dokana-release-baseline-registration',
  );
  const client = await pool.connect();
  try {
    const result = await registerReleaseBaseline(client, input);
    process.stdout.write(
      `Release baseline provenance: OK (effective=${String(result.effectiveMigrationCount)}, replayed=${String(result.replayed)}).\n`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown baseline registration failure.';
  process.stderr.write(`Release baseline provenance: FAIL (${message})\n`);
  process.exitCode = 1;
});
