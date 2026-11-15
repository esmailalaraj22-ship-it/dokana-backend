import type { Pool } from 'pg';

// Compare full stored rows (including IDs, links, amounts and versions). JSON
// stays text so PostgreSQL bigint values never pass through JS floating point.
export async function captureReplayEvidence(
  observer: Pool,
  storeId: string,
  businessTables: readonly string[],
): Promise<Record<string, string[]>> {
  const evidence: Record<string, string[]> = {};
  for (const table of [
    ...businessTables,
    'sync.processed_operations',
    'audit.central_audit_logs',
    'sync.change_events',
    'sync.store_change_events_v1',
  ]) {
    if (!/^(ledger|platform|sync|audit)\.[a-z_0-9]+$/.test(table))
      throw new Error('Invalid evidence table');
    evidence[table] = (
      await observer.query<{ row: string }>(
        `select to_jsonb(t)::text as row from ${table} t where store_id=$1 order by row`,
        [storeId],
      )
    ).rows.map((r) => r.row);
  }
  return evidence;
}
