import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';

import type { RecoveryArtifactStoragePort } from '../../src/recovery/recovery-artifact-storage.port';
import { RecoveryCatalogService } from '../../src/recovery/recovery-catalog.service';
import { RECOVERY_ARTIFACT_MAXIMUM_BYTES } from '../../src/recovery/recovery-manifest';
import {
  assertCompleteDokanaArchiveList,
  listCustomFormatDump,
  type PostgresToolchain,
} from './postgres-tools';
import { sha256File } from './recovery-point-job';
import { runIsolatedRestoreSmoke, type RestoreSmokeResult } from './restore-smoke';

export async function withLatestVerifiedArtifact<T>(input: {
  storage: RecoveryArtifactStoragePort;
  toolchain: PostgresToolchain;
  recoveryPointId?: string;
  work: (value: {
    artifactPath: string;
    manifest: NonNullable<
      Awaited<ReturnType<RecoveryCatalogService['inspectVerifiedCatalog']>>['latestVerified']
    >;
  }) => Promise<T>;
}): Promise<T> {
  const catalog = new RecoveryCatalogService(input.storage);
  const manifest = input.recoveryPointId
    ? (await catalog.readVerifiedRecoveryPoint(input.recoveryPointId))?.manifest
    : (await catalog.inspectVerifiedCatalog()).latestVerified;
  if (!manifest) throw new Error('No valid verified recovery point is available.');
  const directory = await mkdtemp(join(tmpdir(), 'dokana-recovery-verify-'));
  await chmod(directory, 0o700);
  try {
    const path = join(directory, `${manifest.recoveryPointId}.dump`);
    const downloaded = await input.storage.downloadToFile(
      manifest.artifact.key,
      path,
      RECOVERY_ARTIFACT_MAXIMUM_BYTES,
    );
    if (!downloaded || (await sha256File(path)) !== manifest.artifact.sha256) {
      throw new Error('Stored recovery point integrity verification failed.');
    }
    assertCompleteDokanaArchiveList(await listCustomFormatDump(input.toolchain, path));
    return await input.work({ artifactPath: path, manifest });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function verifyLatestStoredRecoveryPoint(input: {
  storage: RecoveryArtifactStoragePort;
  toolchain: PostgresToolchain;
  recoveryPointId?: string;
}): Promise<{ recoveryPointId: string; verifiedAt: string }> {
  return withLatestVerifiedArtifact({
    ...input,
    work: ({ manifest }) =>
      Promise.resolve({
        recoveryPointId: manifest.recoveryPointId,
        verifiedAt: manifest.verification.verifiedAt,
      }),
  });
}

export function restoreSmokeLatestRecoveryPoint(input: {
  storage: RecoveryArtifactStoragePort;
  toolchain: PostgresToolchain;
  adminConnectionString: string;
  recoveryPointId?: string;
  expectedRepresentativeCounts?: Record<string, string>;
  verifyRestoredState?: (pool: Pool) => Promise<void>;
}): Promise<RestoreSmokeResult> {
  return withLatestVerifiedArtifact({
    storage: input.storage,
    toolchain: input.toolchain,
    recoveryPointId: input.recoveryPointId,
    work: ({ artifactPath, manifest }) =>
      runIsolatedRestoreSmoke({
        adminConnectionString: input.adminConnectionString,
        artifactPath,
        manifest,
        toolchain: input.toolchain,
        expectedRepresentativeCounts: input.expectedRepresentativeCounts,
        verifyRestoredState: input.verifyRestoredState,
      }),
  });
}
