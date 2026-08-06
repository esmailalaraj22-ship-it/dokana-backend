import 'dotenv/config';

import { defineConfig } from 'drizzle-kit';

const migrationDatabaseUrl = process.env.DATABASE_MIGRATION_URL;

if (!migrationDatabaseUrl) {
  throw new Error(
    'DATABASE_MIGRATION_URL is required for Drizzle commands. Runtime and administrative URLs are never used.',
  );
}

const parsedMigrationUrl = new URL(migrationDatabaseUrl);

if (!['postgres:', 'postgresql:'].includes(parsedMigrationUrl.protocol)) {
  throw new Error('DATABASE_MIGRATION_URL must use the postgres or postgresql protocol.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './database/migrations',
  dbCredentials: {
    url: migrationDatabaseUrl,
  },
  strict: true,
  verbose: true,
});
