import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AccountingPeriodReadRepository } from './accounting-period-read.repository';
import { AccountingPeriodReadService } from './accounting-period-read.service';
import { AccountingPeriodsController } from './accounting-periods.controller';

@Module({
  imports: [AuthenticationModule, DatabaseModule],
  controllers: [AccountingPeriodsController],
  providers: [AccountingPeriodReadRepository, AccountingPeriodReadService],
})
export class AccountingPeriodsModule {}
