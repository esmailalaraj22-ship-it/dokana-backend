import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AuditController } from './audit.controller';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

@Module({
  imports: [AuthenticationModule, DatabaseModule],
  controllers: [AuditController],
  providers: [AuditRepository, AuditService],
})
export class AuditModule {}
