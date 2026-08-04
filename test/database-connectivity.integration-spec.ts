import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase('Drizzle PostgreSQL connectivity', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({
      connectionString: testDatabaseUrl,
      ssl:
        process.env.TEST_DATABASE_SSL_MODE === 'verify-full' ? { rejectUnauthorized: true } : false,
      max: 1,
      connectionTimeoutMillis: 2_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
      application_name: 'dokana-integration-test',
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('executes a read-only query through Drizzle', async () => {
    const database = drizzle(pool, { logger: false });
    await expect(database.execute(sql`select 1`)).resolves.toBeDefined();
  });

  it('supports transaction-local tenant context without persistent writes', async () => {
    const database = drizzle(pool, { logger: false });
    const context = {
      storeId: randomUUID(),
      userId: randomUUID(),
      deviceId: randomUUID(),
      requestId: randomUUID(),
    };

    await database.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('app.store_id', ${context.storeId}, true)`);
      await transaction.execute(sql`select set_config('app.user_id', ${context.userId}, true)`);
      await transaction.execute(sql`select set_config('app.device_id', ${context.deviceId}, true)`);
      await transaction.execute(
        sql`select set_config('app.request_id', ${context.requestId}, true)`,
      );

      const result = await transaction.execute<{
        storeId: string;
        requestId: string;
      }>(sql`
        select
          current_setting('app.store_id') as "storeId",
          current_setting('app.request_id') as "requestId"
      `);

      expect(result.rows[0]).toEqual({
        storeId: context.storeId,
        requestId: context.requestId,
      });
    });
  });
});
