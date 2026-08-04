import 'dotenv/config';

import { defineConfig } from 'drizzle-kit';

const adminDatabaseUrl = process.env.DATABASE_ADMIN_URL;

if (!adminDatabaseUrl) {
  throw new Error(
    'DATABASE_ADMIN_URL is required for Drizzle administrative commands. The runtime URL is never used.',
  );
}

const parsedAdminUrl = new URL(adminDatabaseUrl);

if (!['postgres:', 'postgresql:'].includes(parsedAdminUrl.protocol)) {
  throw new Error('DATABASE_ADMIN_URL must use the postgres or postgresql protocol.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './database/migrations',
  dbCredentials: {
    url: adminDatabaseUrl,
  },
  strict: true,
  verbose: true,
});
