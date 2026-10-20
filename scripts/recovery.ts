import { resolve } from 'node:path';

import { config as loadEnvironment } from 'dotenv';

import { validateEnvironment, type Environment } from '../src/config/environment';
import { RecoveryCatalogService } from '../src/recovery/recovery-catalog.service';
import { recoveryRuntimeConfigFromEnvironment } from '../src/recovery/recovery-config';
import { createRecoveryArtifactStorage } from '../src/recovery/recovery-storage.factory';
import { resolvePostgresToolchain } from './recovery/postgres-tools';
import { createVerifiedRecoveryPoint } from './recovery/recovery-point-job';
import {
  restoreSmokeLatestRecoveryPoint,
  verifyLatestStoredRecoveryPoint,
} from './recovery/stored-recovery-verification';

type RecoveryCommand = 'create' | 'verify' | 'health' | 'cleanup' | 'restore-smoke';

loadEnvironment({ path: resolve(process.cwd(), '.env') });

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const environment = validateEnvironment(process.env);
  const config = recoveryRuntimeConfigFromEnvironment(environment);
  const storage = createRecoveryArtifactStorage(config.storage);
  if (!storage.configured) throw new Error('Recovery artifact storage is not configured.');
  const catalog = new RecoveryCatalogService(storage);

  if (command === 'health') {
    const state = await catalog.inspectVerifiedCatalog();
    const latestAt = state.latestVerified?.verification.verifiedAt ?? null;
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
    writeResult({ command, ...(await catalog.cleanupExpired(new Date())) });
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
    writeResult({
      command,
      recoveryPointId: manifest.recoveryPointId,
      verifiedAt: manifest.verification.verifiedAt,
      retentionClass: manifest.retentionClass,
    });
    return;
  }
  if (command === 'verify') {
    writeResult({ command, ...(await verifyLatestStoredRecoveryPoint({ storage, toolchain })) });
    return;
  }
  const result = await restoreSmokeLatestRecoveryPoint({
    storage,
    toolchain,
    adminConnectionString: requiredAdminUrl(environment),
  });
  writeResult({
    command,
    isolated: true,
    migrationCount: result.migrationCount,
    latestMigration: result.latestMigration,
    schemas: result.schemas,
  });
}

function parseCommand(value: string | undefined): RecoveryCommand {
  if (
    value === 'create' ||
    value === 'verify' ||
    value === 'health' ||
    value === 'cleanup' ||
    value === 'restore-smoke'
  ) {
    return value;
  }
  throw new Error('Expected recovery command: create, verify, health, cleanup, or restore-smoke.');
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
