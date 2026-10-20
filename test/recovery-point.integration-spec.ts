import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';

import { FilesystemRecoveryArtifactStorage } from '../src/recovery/filesystem-recovery-artifact-storage';
import { RecoveryCatalogService } from '../src/recovery/recovery-catalog.service';
import type { RecoveryRuntimeConfig } from '../src/recovery/recovery-config';
import { RECOVERY_ARTIFACT_MAXIMUM_BYTES } from '../src/recovery/recovery-manifest';
import { resolvePostgresToolchain } from '../scripts/recovery/postgres-tools';
import { createVerifiedRecoveryPoint, sha256File } from '../scripts/recovery/recovery-point-job';
import { readRepresentativeRecoveryCounts } from '../scripts/recovery/restore-smoke';
import {
  restoreSmokeLatestRecoveryPoint,
  verifyLatestStoredRecoveryPoint,
} from '../scripts/recovery/stored-recovery-verification';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeWithDatabase = environment ? describe : describe.skip;

describeWithDatabase('PostgreSQL recovery points with isolated restore smoke', () => {
  let pool: Pool;
  let root: string;

  beforeAll(async () => {
    if (!environment) return;
    pool = createTestPool(environment.adminUrl, 'dokana_recovery_point_integration', 1);
    root = await mkdtemp(join(tmpdir(), 'dokana-recovery-integration-'));
  });

  afterAll(async () => {
    if (!environment) return;
    await pool.end();
    await rm(root, { recursive: true, force: true });
  });

  it('creates, rediscovers, verifies, and restores a complete immutable platform recovery point', async () => {
    if (!environment) throw new Error('Local PostgreSQL integration environment is unavailable.');
    const before = await safetySnapshot(pool);
    const representativeCounts = await readRepresentativeRecoveryCounts(pool);
    const storage = new FilesystemRecoveryArtifactStorage(root);
    const toolchain = await resolvePostgresToolchain(process.env.RECOVERY_POSTGRES_BIN_DIR);
    const config: RecoveryRuntimeConfig = {
      applicationEnvironment: 'test',
      environmentId: 'integration-test',
      sourceRevision: null,
      storage: { driver: 'filesystem', rootDirectory: root },
      logicalMaximumAgeHours: 36,
    };
    const manifest = await createVerifiedRecoveryPoint({
      connectionString: environment.adminUrl,
      config,
      storage,
      toolchain,
    });
    expect(manifest).toMatchObject({
      manifestVersion: '1',
      state: 'VERIFIED',
      backupType: 'postgresql-custom',
      migrations: { appliedCount: 32, checksumStatus: 'PASS' },
      verification: { status: 'VERIFIED', structuralCheck: 'PASS' },
    });
    expect(manifest.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      new RecoveryCatalogService(storage).inspectVerifiedCatalog(),
    ).resolves.toMatchObject({
      latestVerified: { recoveryPointId: manifest.recoveryPointId },
      verifiedCount: 1,
      invalidCount: 0,
    });
    await expect(verifyLatestStoredRecoveryPoint({ storage, toolchain })).resolves.toMatchObject({
      recoveryPointId: manifest.recoveryPointId,
    });

    const restored = await restoreSmokeLatestRecoveryPoint({
      storage,
      toolchain,
      adminConnectionString: environment.adminUrl,
      expectedRepresentativeCounts: representativeCounts,
    });
    expect(restored).toMatchObject({
      schemas: ['audit', 'ledger', 'platform', 'sync'],
      migrationCount: 32,
      latestMigration: manifest.migrations.latestFilename,
    });
    expect(restored.forcedRlsTables).toBeGreaterThan(0);
    expect(restored.policies).toBeGreaterThan(0);
    expect(restored.securityDefinerFunctions).toBeGreaterThan(0);
    expect(restored.triggers).toBeGreaterThan(0);

    expect(await safetySnapshot(pool)).toEqual(before);
    const residue = await pool.query<{ count: number }>(`
      select count(*)::integer as count from pg_database
      where datname like 'dokana_recovery_smoke_%'
    `);
    expect(residue.rows[0]?.count).toBe(0);
    const idle = await pool.query<{ count: number }>(`
      select count(*)::integer as count from pg_stat_activity
      where application_name like 'dokana_recovery_%'
        and state='idle in transaction'
    `);
    expect(idle.rows[0]?.count).toBe(0);
    await expect(
      storage.downloadToFile(
        manifest.artifact.key,
        join(root, 'bounded-copy.dump'),
        RECOVERY_ARTIFACT_MAXIMUM_BYTES,
      ),
    ).resolves.toBe(true);

    const storedArtifactPath = join(root, ...manifest.artifact.key.split('/'));
    const artifact = await open(storedArtifactPath, 'r+');
    try {
      const firstByte = Buffer.alloc(1);
      await artifact.read(firstByte, 0, 1, 0);
      firstByte[0] = (firstByte[0] ?? 0) ^ 0xff;
      await artifact.write(firstByte, 0, 1, 0);
    } finally {
      await artifact.close();
    }
    await expect(sha256File(storedArtifactPath)).resolves.not.toBe(manifest.artifact.sha256);
    await expect(verifyLatestStoredRecoveryPoint({ storage, toolchain })).rejects.toThrow(
      'integrity verification failed',
    );
  }, 120_000);
});

async function safetySnapshot(pool: Pool): Promise<Record<string, number>> {
  const result = await pool.query<Record<string, number>>(`
    select
      (select count(*)::integer from ledger.sales) as sales,
      (select count(*)::integer from ledger.purchase_invoices) as "purchaseInvoices",
      (select count(*)::integer from ledger.money_movements) as "moneyMovements",
      (select count(*)::integer from ledger.inventory_movements) as "inventoryMovements",
      (select count(*)::integer from ledger.expenses) as expenses,
      (select count(*)::integer from ledger.owner_ledger_entries) as "ownerLedgerEntries",
      (select count(*)::integer from sync.processed_operations) as "processedOperations",
      (select count(*)::integer from sync.store_change_events_v1) as "changeEvents",
      (select count(*)::integer from platform.subscriptions) as subscriptions,
      (select count(*)::integer from platform.license_issuances) as "licenseIssuances"
  `);
  const row = result.rows[0];
  if (!row) throw new Error('Recovery safety snapshot is unavailable.');
  return row;
}
