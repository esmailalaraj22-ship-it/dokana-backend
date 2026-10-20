import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';

import {
  UnavailableAttachmentStorage,
  type AttachmentObjectPage,
  type AttachmentStoragePort,
  type PutAttachmentObjectInput,
  type StoredAttachmentObject,
} from '../src/attachments/attachment-storage.port';
import { AttachmentRecoveryCatalogService } from '../src/recovery/attachment-recovery-catalog.service';
import { FilesystemRecoveryArtifactStorage } from '../src/recovery/filesystem-recovery-artifact-storage';
import { RecoveryCatalogService } from '../src/recovery/recovery-catalog.service';
import type { RecoveryRuntimeConfig } from '../src/recovery/recovery-config';
import { RECOVERY_ARTIFACT_MAXIMUM_BYTES } from '../src/recovery/recovery-manifest';
import { readAttachmentInventory } from '../scripts/recovery/attachment-recovery-files';
import {
  protectAttachmentRecoveryPoint,
  verifyAttachmentRecoveryPoint,
} from '../scripts/recovery/attachment-recovery-job';
import { createDumpWithAttachmentSnapshot } from '../scripts/recovery/attachment-recovery-inventory';
import { verifyIsolatedAttachmentRecovery } from '../scripts/recovery/attachment-recovery-smoke';
import { readVerifiedMigrationState } from '../scripts/recovery/migration-state';
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
      attachmentBatchSize: 100,
      attachmentConcurrency: 4,
      attachmentOrphanGraceHours: 168,
    };
    const manifest = await createVerifiedRecoveryPoint({
      connectionString: environment.adminUrl,
      config,
      storage,
      toolchain,
    });
    const attachmentManifest = await protectAttachmentRecoveryPoint({
      recoveryPointId: manifest.recoveryPointId,
      config,
      recoveryStorage: storage,
      sourceStorage: new UnavailableAttachmentStorage(),
    });
    expect(manifest).toMatchObject({
      manifestVersion: '1',
      state: 'VERIFIED',
      backupType: 'postgresql-custom',
      migrations: { appliedCount: 32, checksumStatus: 'PASS' },
      verification: { status: 'VERIFIED', structuralCheck: 'PASS' },
    });
    expect(manifest.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attachmentManifest).toMatchObject({
      recoveryPointId: manifest.recoveryPointId,
      verificationStatus: 'VERIFIED',
      attachmentEntryCount: 0,
    });

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
    await expect(
      verifyAttachmentRecoveryPoint({
        recoveryPointId: manifest.recoveryPointId,
        recoveryStorage: storage,
      }),
    ).resolves.toMatchObject({ recoveryPointId: manifest.recoveryPointId });
    await expect(
      new AttachmentRecoveryCatalogService(
        storage,
        new RecoveryCatalogService(storage),
      ).inspectCoherentCatalog(),
    ).resolves.toMatchObject({
      latestVerified: { recoveryPointId: manifest.recoveryPointId },
      verifiedCount: 1,
      invalidCount: 0,
    });

    const restored = await restoreSmokeLatestRecoveryPoint({
      storage,
      toolchain,
      adminConnectionString: environment.adminUrl,
      recoveryPointId: manifest.recoveryPointId,
      expectedRepresentativeCounts: representativeCounts,
      verifyRestoredState: (restoredPool) =>
        verifyIsolatedAttachmentRecovery({
          pool: restoredPool,
          storage,
          recoveryPointId: manifest.recoveryPointId,
        }),
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

  it('binds the attachment inventory and database dump to one exported snapshot', async () => {
    if (!environment) throw new Error('Local PostgreSQL integration environment is unavailable.');
    const before = await safetySnapshot(pool);
    const storage = new FilesystemRecoveryArtifactStorage(root);
    const fixturePool = createTestPool(
      environment.adminUrl,
      'dokana_recovery_snapshot_fixture',
      2,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    const storeId = '54000000-0000-4000-8000-000000000001';
    const userId = '54000000-0000-4000-8000-000000000002';
    const customerId = '54000000-0000-4000-8000-000000000003';
    const snapshotAttachmentId = '54000000-0000-4000-8000-000000000004';
    const laterAttachmentId = '54000000-0000-4000-8000-000000000005';
    const recoveryPointId = '54000000-0000-4000-8000-000000000006';
    const removedAttachmentId = '54000000-0000-4000-8000-000000000007';
    const snapshotBody = Buffer.from('snapshot attachment');
    const laterBody = Buffer.from('later attachment');
    const dumpPath = join(root, `${recoveryPointId}.snapshot.dump`);
    const inventoryPath = join(root, `${recoveryPointId}.snapshot.ndjson`);
    const toolchain = await resolvePostgresToolchain(process.env.RECOVERY_POSTGRES_BIN_DIR);
    try {
      await fixturePool.query(
        `insert into ledger.stores (id,name,status) values ($1,'Recovery Snapshot','active')`,
        [storeId],
      );
      await fixturePool.query(
        `insert into platform.users (id,email,normalized_email,password_hash,full_name,status)
         values ($1,'recovery-snapshot@example.test','recovery-snapshot@example.test','not-used','Recovery Snapshot','active')`,
        [userId],
      );
      await fixturePool.query(
        `insert into ledger.customers (
           id,store_id,name,normalized_name,phone,normalized_phone,status,operation_id
         ) values ($1,$2,'Recovery Customer','recovery customer','+970590000001','+970590000001','active',$3)`,
        [customerId, storeId, randomUUID()],
      );
      await fixturePool.query(
        `insert into ledger.attachments (
           id,store_id,entity_type,entity_id,kind,file_name,mime_type,remote_key,
           file_size_bytes,checksum_sha256,sync_status
         ) values ($1,$2,'customer',$3,'document','snapshot.pdf','application/pdf',$4,$5,$6,'uploaded')`,
        [
          snapshotAttachmentId,
          storeId,
          customerId,
          `stores/${storeId}/attachments/${snapshotAttachmentId}`,
          snapshotBody.byteLength,
          createHash('sha256').update(snapshotBody).digest('hex'),
        ],
      );
      await fixturePool.query(
        `insert into ledger.attachments (
           id,store_id,entity_type,entity_id,kind,file_name,mime_type,remote_key,
           file_size_bytes,checksum_sha256,sync_status,removed_at,removed_by_user_id
         ) values (
           $1,$2,'customer',$3,'document','already-removed.pdf','application/pdf',$4,
           $5,$6,'deleted',clock_timestamp(),$7
         )`,
        [
          removedAttachmentId,
          storeId,
          customerId,
          `stores/${storeId}/attachments/${removedAttachmentId}`,
          snapshotBody.byteLength,
          createHash('sha256').update(snapshotBody).digest('hex'),
          userId,
        ],
      );

      await createDumpWithAttachmentSnapshot({
        connectionString: environment.adminUrl,
        toolchain,
        dumpPath,
        inventoryPath,
        recoveryPointId,
        createdAt: new Date('2026-10-20T00:00:00.000Z'),
        batchSize: 10,
        onSnapshotExported: async () => {
          await fixturePool.query(
            `update ledger.attachments
             set removed_at=clock_timestamp(), removed_by_user_id=$2
             where id=$1`,
            [snapshotAttachmentId, userId],
          );
          await fixturePool.query(
            `insert into ledger.attachments (
               id,store_id,entity_type,entity_id,kind,file_name,mime_type,remote_key,
               file_size_bytes,checksum_sha256,sync_status
             ) values ($1,$2,'customer',$3,'document','later.pdf','application/pdf',$4,$5,$6,'uploaded')`,
            [
              laterAttachmentId,
              storeId,
              customerId,
              `stores/${storeId}/attachments/${laterAttachmentId}`,
              laterBody.byteLength,
              createHash('sha256').update(laterBody).digest('hex'),
            ],
          );
        },
      });

      const capturedIds: string[] = [];
      for await (const entry of readAttachmentInventory(inventoryPath, recoveryPointId)) {
        if (entry.storeId === storeId) capturedIds.push(entry.attachmentId);
      }
      expect(capturedIds).toEqual([snapshotAttachmentId]);

      const migrationState = await readVerifiedMigrationState(environment.adminUrl);
      const dumpDetails = await stat(dumpPath);
      const inventoryDetails = await stat(inventoryPath);
      const databaseDigest = await sha256File(dumpPath);
      const inventoryDigest = await sha256File(inventoryPath);
      await storage.putFile({
        key: `recovery/v1/database/${recoveryPointId}.dump`,
        sourcePath: dumpPath,
        contentType: 'application/vnd.postgresql.custom',
        contentLength: dumpDetails.size,
        checksumSha256: databaseDigest,
      });
      await storage.putFile({
        key: `recovery/v1/attachments/inventory/${recoveryPointId}.ndjson`,
        sourcePath: inventoryPath,
        contentType: 'application/x-ndjson',
        contentLength: inventoryDetails.size,
        checksumSha256: inventoryDigest,
      });
      await new RecoveryCatalogService(storage).writeManifest({
        manifestVersion: '1',
        recoveryPointId,
        state: 'VERIFIED',
        createdAt: '2026-10-20T00:00:00.000Z',
        completedAt: '2026-10-20T00:00:00.000Z',
        environmentId: 'integration-test',
        sourceRevision: null,
        backupType: 'postgresql-custom',
        artifact: {
          key: `recovery/v1/database/${recoveryPointId}.dump`,
          sizeBytes: dumpDetails.size,
          sha256: databaseDigest,
        },
        postgres: { serverVersion: migrationState.serverVersion, toolVersion: 'pg_dump' },
        migrations: {
          appliedCount: migrationState.appliedCount,
          latestFilename: migrationState.latestFilename,
          checksumStatus: 'PASS',
          checksumAggregateSha256: migrationState.checksumAggregateSha256,
        },
        verification: {
          status: 'VERIFIED',
          structuralCheck: 'PASS',
          verifiedAt: '2026-10-20T00:00:00.000Z',
        },
        retentionClass: 'DAILY',
      });
      const sourceStorage = new RecoveryTestAttachmentStorage();
      sourceStorage.set(`stores/${storeId}/attachments/${snapshotAttachmentId}`, snapshotBody);
      await expect(
        protectAttachmentRecoveryPoint({
          recoveryPointId,
          config: {
            applicationEnvironment: 'test',
            environmentId: 'integration-test',
            sourceRevision: null,
            storage: { driver: 'filesystem', rootDirectory: root },
            logicalMaximumAgeHours: 36,
            attachmentBatchSize: 10,
            attachmentConcurrency: 2,
            attachmentOrphanGraceHours: 168,
          },
          recoveryStorage: storage,
          sourceStorage,
        }),
      ).resolves.toMatchObject({ attachmentEntryCount: 1 });
      await restoreSmokeLatestRecoveryPoint({
        storage,
        toolchain,
        adminConnectionString: environment.adminUrl,
        recoveryPointId,
        verifyRestoredState: async (restoredPool) => {
          await verifyIsolatedAttachmentRecovery({
            pool: restoredPool,
            storage,
            recoveryPointId,
          });
          const restored = await restoredPool.query<{ id: string; removed: boolean }>(
            `select id, removed_at is not null as removed
             from ledger.attachments
             where id=any($1::uuid[])
             order by id`,
            [[snapshotAttachmentId, laterAttachmentId, removedAttachmentId]],
          );
          expect(restored.rows).toEqual([
            { id: snapshotAttachmentId, removed: false },
            { id: removedAttachmentId, removed: true },
          ]);
        },
      });

      const live = await fixturePool.query<{ id: string; removed: boolean }>(
        `select id, removed_at is not null as removed
         from ledger.attachments
         where id=any($1::uuid[])
         order by id`,
        [[snapshotAttachmentId, laterAttachmentId, removedAttachmentId]],
      );
      expect(live.rows).toEqual([
        { id: snapshotAttachmentId, removed: true },
        { id: laterAttachmentId, removed: false },
        { id: removedAttachmentId, removed: true },
      ]);
    } finally {
      await fixturePool.query(`delete from ledger.attachments where store_id=$1`, [storeId]);
      await fixturePool.query(`delete from ledger.customers where store_id=$1`, [storeId]);
      await fixturePool.query(`delete from platform.users where id=$1`, [userId]);
      await fixturePool.query(`delete from ledger.stores where id=$1`, [storeId]);
      await fixturePool.end();
    }
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
  }, 120_000);
});

class RecoveryTestAttachmentStorage implements AttachmentStoragePort {
  private readonly objects = new Map<string, Buffer>();

  set(key: string, body: Buffer): void {
    this.objects.set(key, Buffer.from(body));
  }

  putObject(input: PutAttachmentObjectInput): Promise<void> {
    this.set(input.key, input.body);
    return Promise.resolve();
  }

  getObject(key: string): Promise<StoredAttachmentObject | null> {
    const body = this.objects.get(key);
    return Promise.resolve(
      body ? { body: Buffer.from(body), contentLength: body.byteLength } : null,
    );
  }

  deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  objectExists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }

  listObjects(): Promise<AttachmentObjectPage> {
    return Promise.resolve({ objects: [], nextToken: null });
  }
}

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
      (select count(*)::integer from platform.license_issuances) as "licenseIssuances",
      (select count(*)::integer from ledger.attachments) as attachments
  `);
  const row = result.rows[0];
  if (!row) throw new Error('Recovery safety snapshot is unavailable.');
  return row;
}
