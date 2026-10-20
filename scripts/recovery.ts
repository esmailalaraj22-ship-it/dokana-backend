import { resolve } from 'node:path';

import { config as loadEnvironment } from 'dotenv';

import { S3AttachmentStorage } from '../src/attachments/s3-attachment-storage';
import { UnavailableAttachmentStorage } from '../src/attachments/attachment-storage.port';
import { validateEnvironment, type Environment } from '../src/config/environment';
import { AttachmentRecoveryCatalogService } from '../src/recovery/attachment-recovery-catalog.service';
import { RecoveryCatalogService } from '../src/recovery/recovery-catalog.service';
import { recoveryRuntimeConfigFromEnvironment } from '../src/recovery/recovery-config';
import { createRecoveryArtifactStorage } from '../src/recovery/recovery-storage.factory';
import { resolvePostgresToolchain } from './recovery/postgres-tools';
import {
  protectAttachmentRecoveryPoint,
  verifyAttachmentRecoveryPoint,
} from './recovery/attachment-recovery-job';
import { cleanupAttachmentRecovery } from './recovery/attachment-recovery-retention';
import { verifyIsolatedAttachmentRecovery } from './recovery/attachment-recovery-smoke';
import { createVerifiedRecoveryPoint } from './recovery/recovery-point-job';
import {
  restoreSmokeLatestRecoveryPoint,
  verifyLatestStoredRecoveryPoint,
} from './recovery/stored-recovery-verification';

type RecoveryCommand =
  'create' | 'protect-attachments' | 'verify' | 'health' | 'cleanup' | 'restore-smoke';

loadEnvironment({ path: resolve(process.cwd(), '.env') });

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const environment = validateEnvironment(process.env);
  const config = recoveryRuntimeConfigFromEnvironment(environment);
  const storage = createRecoveryArtifactStorage(config.storage);
  if (!storage.configured) throw new Error('Recovery artifact storage is not configured.');
  const catalog = new RecoveryCatalogService(storage);
  const attachmentCatalog = new AttachmentRecoveryCatalogService(storage, catalog);

  if (command === 'health') {
    const state = await attachmentCatalog.inspectCoherentCatalog();
    const latestAt = state.latestVerified?.verifiedAt ?? null;
    const latestTime = latestAt === null ? null : new Date(latestAt).getTime();
    const healthy =
      latestTime !== null &&
      latestTime <= Date.now() &&
      Date.now() - latestTime <= config.logicalMaximumAgeHours * 3_600_000 &&
      state.invalidCount === 0;
    writeResult({ command, healthy, latestVerifiedRecoveryPointAt: latestAt });
    return;
  }
  if (command === 'cleanup') {
    writeResult({ command, ...(await cleanupAttachmentRecovery({ storage, config })) });
    return;
  }
  if (command === 'protect-attachments') {
    const recoveryPointId = requiredRecoveryPointId(process.argv[3]);
    const attachmentManifest = await protectAttachmentRecoveryPoint({
      recoveryPointId,
      config,
      recoveryStorage: storage,
      sourceStorage: createAttachmentStorage(environment),
    });
    writeResult({
      command,
      recoveryPointId,
      attachmentsVerifiedAt: attachmentManifest.verifiedAt,
    });
    return;
  }

  const toolchain = await resolvePostgresToolchain(environment.RECOVERY_POSTGRES_BIN_DIR);
  if (command === 'create') {
    const manifest = await createVerifiedRecoveryPoint({
      connectionString: recoveryDatabaseUrl(environment),
      config,
      storage,
      toolchain,
    });
    const attachmentManifest = await protectAttachmentRecoveryPoint({
      recoveryPointId: manifest.recoveryPointId,
      config,
      recoveryStorage: storage,
      sourceStorage: createAttachmentStorage(environment),
    });
    writeResult({
      command,
      recoveryPointId: manifest.recoveryPointId,
      databaseVerifiedAt: manifest.verification.verifiedAt,
      attachmentsVerifiedAt: attachmentManifest.verifiedAt,
      retentionClass: manifest.retentionClass,
    });
    return;
  }
  if (command === 'verify') {
    const requestedRecoveryPointId = process.argv[3];
    const latest = requestedRecoveryPointId
      ? await attachmentCatalog.readVerifiedManifest(requestedRecoveryPointId)
      : (await attachmentCatalog.inspectCoherentCatalog()).latestVerified;
    if (!latest) throw new Error('No coherent recovery point is available.');
    const database = await verifyLatestStoredRecoveryPoint({
      storage,
      toolchain,
      recoveryPointId: latest.recoveryPointId,
    });
    const attachments = await verifyAttachmentRecoveryPoint({
      recoveryPointId: latest.recoveryPointId,
      recoveryStorage: storage,
    });
    writeResult({ command, database, attachments });
    return;
  }
  const coherent = await attachmentCatalog.inspectCoherentCatalog();
  const latest = coherent.latestVerified;
  if (!latest) throw new Error('No coherent recovery point is available.');
  const result = await restoreSmokeLatestRecoveryPoint({
    storage,
    toolchain,
    adminConnectionString: requiredAdminUrl(environment),
    recoveryPointId: latest.recoveryPointId,
    verifyRestoredState: (pool) =>
      verifyIsolatedAttachmentRecovery({
        pool,
        storage,
        recoveryPointId: latest.recoveryPointId,
      }),
  });
  writeResult({
    command,
    isolated: true,
    migrationCount: result.migrationCount,
    latestMigration: result.latestMigration,
    schemas: result.schemas,
  });
}

function createAttachmentStorage(environment: Environment) {
  if (!environment.ATTACHMENT_S3_BUCKET) return new UnavailableAttachmentStorage();
  return new S3AttachmentStorage({
    endpoint: environment.ATTACHMENT_S3_ENDPOINT,
    region: environment.ATTACHMENT_S3_REGION,
    bucket: environment.ATTACHMENT_S3_BUCKET,
    accessKeyId: environment.ATTACHMENT_S3_ACCESS_KEY_ID,
    secretAccessKey: environment.ATTACHMENT_S3_SECRET_ACCESS_KEY,
    forcePathStyle: environment.ATTACHMENT_S3_FORCE_PATH_STYLE,
    timeoutMs: environment.ATTACHMENT_STORAGE_TIMEOUT_MS,
  });
}

function parseCommand(value: string | undefined): RecoveryCommand {
  if (
    value === 'create' ||
    value === 'protect-attachments' ||
    value === 'verify' ||
    value === 'health' ||
    value === 'cleanup' ||
    value === 'restore-smoke'
  ) {
    return value;
  }
  throw new Error(
    'Expected recovery command: create, protect-attachments, verify, health, cleanup, or restore-smoke.',
  );
}

function requiredRecoveryPointId(value: string | undefined): string {
  if (!value) throw new Error('A recoveryPointId argument is required.');
  return value;
}

function recoveryDatabaseUrl(environment: Environment): string {
  if (environment.RECOVERY_DATABASE_URL) return environment.RECOVERY_DATABASE_URL;
  if (environment.APP_ENV !== 'production' && environment.DATABASE_ADMIN_URL) {
    return environment.DATABASE_ADMIN_URL;
  }
  throw new Error('RECOVERY_DATABASE_URL is required for this environment.');
}

function requiredAdminUrl(environment: Environment): string {
  if (!environment.DATABASE_ADMIN_URL || environment.APP_ENV === 'production') {
    throw new Error('Restore-smoke requires a local non-production administrative URL.');
  }
  return environment.DATABASE_ADMIN_URL;
}

function writeResult(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

void main().catch(() => {
  process.stderr.write('Recovery command failed.\n');
  process.exitCode = 1;
});
