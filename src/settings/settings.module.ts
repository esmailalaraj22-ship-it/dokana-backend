import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AppSettingsReadRepository } from './app-settings-read.repository';
import { AppSettingsReadService } from './app-settings-read.service';
import { OperationalTimeService } from './operational-time.service';
import { SettingsController } from './settings.controller';

@Module({
  imports: [AuthenticationModule, DatabaseModule],
  controllers: [SettingsController],
  providers: [AppSettingsReadRepository, AppSettingsReadService, OperationalTimeService],
  exports: [OperationalTimeService],
})
export class SettingsModule {}
