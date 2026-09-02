import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AccountingPeriodReadRepository } from './accounting-period-read.repository';
import { AccountingPeriodReadService } from './accounting-period-read.service';
import { AccountingPeriodProvisioningRepository } from './accounting-period-provisioning.repository';
import { AccountingPeriodProvisioningService } from './accounting-period-provisioning.service';
import { AccountingPeriodWriteRepository } from './accounting-period-write.repository';
import { AccountingPeriodWriteService } from './accounting-period-write.service';
import { AccountingPeriodsController } from './accounting-periods.controller';

@Module({
  imports: [AuthenticationModule, DatabaseModule],
  controllers: [AccountingPeriodsController],
  providers: [
    AccountingPeriodReadRepository,
    AccountingPeriodReadService,
    AccountingPeriodProvisioningRepository,
    AccountingPeriodProvisioningService,
    AccountingPeriodWriteRepository,
    AccountingPeriodWriteService,
  ],
  exports: [AccountingPeriodProvisioningService],
})
export class AccountingPeriodsModule {}
