import type { AppConfigService } from '../config/app-config.service';
import type { PitrStatusPort } from './pitr-status.port';
import type { RecoveryCatalogService } from './recovery-catalog.service';
import { RecoveryHealthService } from './recovery-health.service';

const storeId = '43000000-0000-4000-8000-000000000001';

describe('RecoveryHealthService', () => {
  const pitr = {
    readStatus: jest.fn(),
  } as jest.Mocked<PitrStatusPort>;
  const catalog = {
    configured: true,
    inspectVerifiedCatalog: jest.fn(),
  } as unknown as jest.Mocked<Pick<RecoveryCatalogService, 'inspectVerifiedCatalog'>> & {
    configured: boolean;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    catalog.configured = true;
    pitr.readStatus.mockResolvedValue({
      status: 'unverified',
      retentionDays: null,
      latestRecoverableAt: null,
    });
  });

  it('keeps recent verified logical protection healthy without claiming PITR', async () => {
    catalog.inspectVerifiedCatalog.mockResolvedValue({
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
    catalog.inspectVerifiedCatalog.mockResolvedValue({
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
    catalog.configured = false;
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
        },
      } as AppConfigService,
      catalog as unknown as RecoveryCatalogService,
      pitr,
    );
  }
});

function manifest(verifiedAt: string) {
  return {
    manifestVersion: '1' as const,
    recoveryPointId: '43000000-0000-4000-8000-000000000010',
    state: 'VERIFIED' as const,
    createdAt: verifiedAt,
    completedAt: verifiedAt,
    environmentId: 'test',
    sourceRevision: null,
    backupType: 'postgresql-custom' as const,
    artifact: {
      key: 'recovery/v1/database/43000000-0000-4000-8000-000000000010.dump',
      sizeBytes: 100,
      sha256: 'a'.repeat(64),
    },
    postgres: { serverVersion: '18', toolVersion: 'pg_dump 18' },
    migrations: {
      appliedCount: 32,
      latestFilename: '0032_attachment_lifecycle_audit.sql',
      checksumStatus: 'PASS' as const,
      checksumAggregateSha256: 'b'.repeat(64),
    },
    verification: { status: 'VERIFIED' as const, structuralCheck: 'PASS' as const, verifiedAt },
    retentionClass: 'DAILY' as const,
  };
}
