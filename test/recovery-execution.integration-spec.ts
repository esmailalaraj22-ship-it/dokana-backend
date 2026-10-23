import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UnavailableAttachmentStorage } from '../src/attachments/attachment-storage.port';
import { FilesystemRecoveryArtifactStorage } from '../src/recovery/filesystem-recovery-artifact-storage';
import type { RecoveryRuntimeConfig } from '../src/recovery/recovery-config';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import { protectAttachmentRecoveryPoint } from '../scripts/recovery/attachment-recovery-job';
import { resolvePostgresToolchain } from '../scripts/recovery/postgres-tools';
import { RecoveryExecutionService } from '../scripts/recovery/recovery-execution';
import { readRecoveryControl, withDatabase } from '../scripts/recovery/recovery-target';
import { createVerifiedRecoveryPoint } from '../scripts/recovery/recovery-point-job';
import { createInventoryTestDatabase } from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0033_platform_recovery_generation_fencing.sql';
const environment = readLocalPostgresTestEnvironment();
const describeWithDatabase = environment ? describe : describe.skip;

describeWithDatabase('isolated platform recovery execution', () => {
  it('separates restore, verification, approval, and activation with one durable authority', async () => {
    if (!environment) throw new Error('Local PostgreSQL integration environment is unavailable.');
    const source = await createInventoryTestDatabase(migrationFilename);
    const root = await mkdtemp(join(tmpdir(), 'dokana-recovery-execution-'));
    let targetDatabaseName: string | null = null;
    try {
      const migration = await source.migration.connect();
      try {
        await verifyMigrationSession(migration);
        await applyMigration(migration, source.file);
      } finally {
        await migration.query('reset role');
        migration.release();
      }

      const currentDatabase = await source.admin.query<{ name: string }>(
        `select current_database() as name`,
      );
      const sourceDatabaseName = currentDatabase.rows[0]?.name;
      if (!sourceDatabaseName) throw new Error('Disposable source database is unavailable.');
      const sourceAdminUrl = withDatabase(environment.adminUrl, sourceDatabaseName);
      const sourceMigrationUrl = withDatabase(environment.migrationUrl, sourceDatabaseName);
      const sourceRuntimeUrl = withDatabase(environment.runtimeUrl, sourceDatabaseName);
      const storage = new FilesystemRecoveryArtifactStorage(root);
      const toolchain = await resolvePostgresToolchain(process.env.RECOVERY_POSTGRES_BIN_DIR);
      const config: RecoveryRuntimeConfig = {
        applicationEnvironment: 'test',
        environmentId: 'integration-test',
        sourceRevision: null,
        storage: { driver: 'filesystem', rootDirectory: root },
        logicalMaximumAgeHours: 36,
        attachmentBatchSize: 100,
        attachmentConcurrency: 2,
        attachmentOrphanGraceHours: 168,
      };
      const point = await createVerifiedRecoveryPoint({
        connectionString: sourceAdminUrl,
        config,
        storage,
        toolchain,
      });
      await protectAttachmentRecoveryPoint({
        recoveryPointId: point.recoveryPointId,
        config,
        recoveryStorage: storage,
        sourceStorage: new UnavailableAttachmentStorage(),
      });
      expect(point.migrations).toMatchObject({
        appliedCount: 33,
        latestFilename: migrationFilename,
        checksumStatus: 'PASS',
      });

      const execution = () =>
        new RecoveryExecutionService({
          storage,
          targetAttachmentStorage: new UnavailableAttachmentStorage(),
          toolchain,
          adminConnectionString: sourceAdminUrl,
          migrationConnectionString: sourceMigrationUrl,
          runtimeConnectionString: sourceRuntimeUrl,
          applicationEnvironment: 'test',
          environmentId: 'integration-test',
        });
      const prepared = await execution().prepare(point.recoveryPointId);
      targetDatabaseName = prepared.targetDatabaseName;
      expect(prepared.phase).toBe('PREPARED');
      await expect(execution().prepare(point.recoveryPointId)).rejects.toThrow('already active');
      await expect(
        execution().activate(prepared.recoveryAttemptId, point.recoveryPointId),
      ).rejects.toThrow('not bound');

      await expect(execution().restoreDatabase(prepared.recoveryAttemptId)).resolves.toMatchObject({
        phase: 'DATABASE_RESTORED',
        targetDatabaseName,
      });
      const sourceFenced = await readRecoveryControl(sourceMigrationUrl);
      const targetMigrationUrl = withDatabase(environment.migrationUrl, targetDatabaseName);
      const restoredTarget = await readRecoveryControl(targetMigrationUrl);
      expect(sourceFenced).toMatchObject({ serviceState: 'FENCED' });
      expect(restoredTarget).toMatchObject({
        serviceState: 'FENCED',
        recoveryGenerationId: sourceFenced.recoveryGenerationId,
      });

      await expect(
        execution().restoreAttachments(prepared.recoveryAttemptId),
      ).resolves.toMatchObject({ phase: 'ATTACHMENTS_RESTORED' });
      await expect(execution().verify(prepared.recoveryAttemptId)).resolves.toMatchObject({
        phase: 'VERIFIED',
      });
      await expect(
        execution().approve(prepared.recoveryAttemptId, '63000000-0000-4000-8000-000000000099'),
      ).rejects.toThrow('not bound');
      await expect(
        execution().activate(prepared.recoveryAttemptId, point.recoveryPointId),
      ).rejects.toThrow('not bound');
      await expect(
        execution().approve(prepared.recoveryAttemptId, point.recoveryPointId),
      ).resolves.toMatchObject({ phase: 'APPROVED' });
      const activated = await execution().activate(
        prepared.recoveryAttemptId,
        point.recoveryPointId,
      );
      expect(activated).toMatchObject({ phase: 'ACTIVATED', targetDatabaseName });
      expect(activated.recoveryGenerationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(activated.recoveryGenerationId).not.toBe(restoredTarget.recoveryGenerationId);

      const activeTarget = await readRecoveryControl(targetMigrationUrl);
      expect(activeTarget).toMatchObject({
        serviceState: 'ACTIVE',
        recoveryGenerationId: activated.recoveryGenerationId,
      });
      expect(activeTarget.authorityNotBefore).not.toBeNull();
      await expect(
        execution().activate(prepared.recoveryAttemptId, point.recoveryPointId),
      ).resolves.toMatchObject({ phase: 'ACTIVATED' });

      const targetRuntime = createTestPool(
        withDatabase(environment.runtimeUrl, targetDatabaseName),
        'dokana-recovery-stale-generation',
        1,
      );
      try {
        await expect(
          targetRuntime.query(`select ledger.assert_platform_write_authority_v1($1::uuid)`, [
            restoredTarget.recoveryGenerationId,
          ]),
        ).rejects.toThrow();
        await expect(
          targetRuntime.query(`select ledger.assert_platform_write_authority_v1($1::uuid)`, [
            activated.recoveryGenerationId,
          ]),
        ).resolves.toMatchObject({ rowCount: 1 });
      } finally {
        await targetRuntime.end();
      }
      expect(await readRecoveryControl(sourceMigrationUrl)).toMatchObject({
        serviceState: 'FENCED',
        recoveryGenerationId: sourceFenced.recoveryGenerationId,
      });
    } finally {
      if (targetDatabaseName) {
        const management = createTestPool(
          withDatabase(environment.adminUrl, 'postgres'),
          'dokana-recovery-execution-cleanup',
          1,
        );
        try {
          await management.query(
            `select pg_terminate_backend(pid) from pg_stat_activity
             where datname=$1 and pid<>pg_backend_pid()`,
            [targetDatabaseName],
          );
          if (/^dokana_recovery_[0-9a-f]{32}$/.test(targetDatabaseName)) {
            await management.query(`drop database if exists "${targetDatabaseName}"`);
          }
        } finally {
          await management.end();
        }
      }
      await source.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
