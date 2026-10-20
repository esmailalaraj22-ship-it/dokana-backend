import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { AppConfigService } from '../config/app-config.service';
import { BackupStatusController } from './backup-status.controller';
import { BackupStatusService } from './backup-status.service';
import { PITR_STATUS, UnverifiedPitrStatus } from './pitr-status.port';
import { RECOVERY_ARTIFACT_STORAGE } from './recovery-artifact-storage.port';
import { RecoveryCatalogService } from './recovery-catalog.service';
import { RecoveryHealthService } from './recovery-health.service';
import { createRecoveryArtifactStorage } from './recovery-storage.factory';

@Module({
  imports: [AuthenticationModule],
  controllers: [BackupStatusController],
  providers: [
    BackupStatusService,
    RecoveryCatalogService,
    RecoveryHealthService,
    { provide: PITR_STATUS, useClass: UnverifiedPitrStatus },
    {
      provide: RECOVERY_ARTIFACT_STORAGE,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        createRecoveryArtifactStorage(config.recovery.storage),
    },
  ],
  exports: [RecoveryCatalogService, RecoveryHealthService],
})
export class RecoveryModule {}
