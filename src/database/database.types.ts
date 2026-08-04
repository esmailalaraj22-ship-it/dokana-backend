import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export type DatabaseSchema = Record<string, never>;
export type DatabaseClient = NodePgDatabase<DatabaseSchema>;
export type DatabaseTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

export interface TenantTransactionContext {
  storeId: string;
  userId: string;
  deviceId: string;
  requestId: string;
}

export interface DatabaseReadiness {
  ready: boolean;
  latencyMs: number;
}
