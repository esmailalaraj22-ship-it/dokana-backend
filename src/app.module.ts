import { Module } from '@nestjs/common';

import { CommonModule } from './common/common.module';
import { LoggingModule } from './common/logging/logging.module';
import { ApplicationConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [ApplicationConfigModule, LoggingModule, CommonModule, HealthModule],
})
export class AppModule {}
