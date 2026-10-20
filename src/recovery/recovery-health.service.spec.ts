import type { AppConfigService } from '../config/app-config.service';
import type { VerifiedAttachmentRecoveryManifest } from './attachment-recovery-manifest';
import type { AttachmentRecoveryCatalogService } from './attachment-recovery-catalog.service';
import type { PitrStatusPort } from './pitr-status.port';
import type { RecoveryCatalogService } from './recovery-catalog.service';
import { RecoveryHealthService } from './recovery-health.service';

const storeId = '43000000-0000-4000-8000-000000000001';

describe('RecoveryHealthService', () => {
  const pitr = {
    readStatus: jest.fn(),
  } as jest.Mocked<PitrStatusPort>;
  const databaseCatalog = {
    configured: true,
  } as unknown as RecoveryCatalogService & {
    configured: boolean;
  };
  const attachmentCatalog = {
    inspectCoherentCatalog: jest.fn(),
  } as unknown as jest.Mocked<Pick<AttachmentRecoveryCatalogService, 'inspectCoherentCatalog'>>;

  beforeEach(() => {
    jest.clearAllMocks();
    databaseCatalog.configured = true;
    pitr.readStatus.mockResolvedValue({
      status: 'unverified',
      retentionDays: null,
      latestRecoverableAt: null,
    });
  });

  it('keeps recent verified logical protection healthy without claiming PITR', async () => {
    attachmentCatalog.inspectCoherentCatalog.mockResolvedValue({
      latestVerified: manifest('2026-10-19T00:00:00.000Z'),
      verifiedCount: 1,
      invalidCount: 0,
    });
    const service = createService('production');
    await expect(service.evaluate(new Date('2026-10-19T12:00:00.000Z'))).resolves.toEqual({
      protectionStatus: 'protected',
      logicalBackupStatus: 'healthy',
      pitrStatus: 'unverified',
      lastVerifiedRecoveryPointAt: new Date('2026-10-19T00:00:00.000Z'),
      attentionRequired: false,
    });
    await expect(
      service.notificationCause(storeId, new Date('2026-10-19T12:00:00.000Z')),
    ).resolves.toBeNull();
  });

  it('creates one stable Store-scoped cause only after verified protection is lost', async () => {
    attachmentCatalog.inspectCoherentCatalog.mockResolvedValue({
      latestVerified: manifest('2026-10-15T00:00:00.000Z'),
      verifiedCount: 1,
      invalidCount: 0,
    });
    const service = createService('production');
    const first = await service.notificationCause(storeId, new Date('2026-10-19T12:00:00.000Z'));
    const second = await service.notificationCause(storeId, new Date('2026-10-19T12:01:00.000Z'));
    expect(first).toMatchObject({
      key: `s21:v1:backup_failure:backup_protection:${storeId}`,
      type: 'backup_failure',
      entityId: storeId,
    });
    expect(second?.key).toBe(first?.key);
  });

  it('does not create false development alerts for an unconfigured PITR environment', async () => {
    databaseCatalog.configured = false;
    const service = createService('development');
    await expect(service.notificationCause(storeId)).resolves.toBeNull();
    await expect(service.evaluate()).resolves.toMatchObject({
      protectionStatus: 'configuration_required',
      logicalBackupStatus: 'unconfigured',
      pitrStatus: 'unverified',
      attentionRequired: false,
    });
  });

  function createService(environment: 'development' | 'production'): RecoveryHealthService {
    return new RecoveryHealthService(
      {
        recovery: {
          applicationEnvironment: environment,
          environmentId: 'test',
          sourceRevision: null,
          storage: { driver: 'unconfigured' },
          logicalMaximumAgeHours: 36,
          attachmentBatchSize: 100,
          attachmentConcurrency: 4,
          attachmentOrphanGraceHours: 168,
        },
      } as AppConfigService,
      databaseCatalog,
      attachmentCatalog as unknown as AttachmentRecoveryCatalogService,
      pitr,
    );
  }
});

function manifest(verifiedAt: string): VerifiedAttachmentRecoveryManifest {
  return {
    manifestVersion: '1' as const,
    recoveryPointId: '43000000-0000-4000-8000-000000000010',
    databaseManifest: {
      key: 'recovery/v1/manifests/verified/43000000-0000-4000-8000-000000000010.json',
      sha256: 'a'.repeat(64),
    },
    databaseArtifactSha256: 'b'.repeat(64),
    snapshotInventory: {
      method: 'SHARED_POSTGRESQL_SNAPSHOT',
      key: 'recovery/v1/attachments/inventory/43000000-0000-4000-8000-000000000010.ndjson',
      sizeBytes: 100,
      sha256: 'c'.repeat(64),
    },
    createdAt: verifiedAt,
    verifiedAt,
    digestAlgorithm: 'SHA-256',
    verificationStatus: 'VERIFIED',
    attachmentEntryCount: 0,
    totalProtectedBytes: '0',
    entries: {
      key: 'recovery/v1/attachments/entries/43000000-0000-4000-8000-000000000010.ndjson',
      sizeBytes: 100,
      sha256: 'd'.repeat(64),
    },
  };
}
