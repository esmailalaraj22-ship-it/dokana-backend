import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { PlatformAuthorityService } from './platform-authority.service';

@Module({
  imports: [DatabaseModule],
  providers: [PlatformAuthorityService],
  exports: [PlatformAuthorityService],
})
export class PlatformAuthorityModule {}
