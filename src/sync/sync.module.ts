import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { OfflineLicensesModule } from '../offline-licenses/offline-licenses.module';
import { BOOTSTRAP_ARTIFACT_ROOT, BootstrapArtifactStore } from './bootstrap-artifact.store';
import { BootstrapController } from './bootstrap.controller';
import { BootstrapRepository } from './bootstrap.repository';
import { BootstrapService } from './bootstrap.service';

@Module({
  imports: [AuthenticationModule, DatabaseModule, OfflineLicensesModule],
  controllers: [BootstrapController],
  providers: [
    {
      provide: BOOTSTRAP_ARTIFACT_ROOT,
      useFactory: () => join(tmpdir(), 'dokana-bootstrap-v1'),
    },
    BootstrapArtifactStore,
    BootstrapRepository,
    BootstrapService,
  ],
})
export class SyncModule {}
