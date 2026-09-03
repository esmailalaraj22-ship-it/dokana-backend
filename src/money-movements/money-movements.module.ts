import { Module } from '@nestjs/common';

import { AccountingPeriodsModule } from '../accounting-periods/accounting-periods.module';
import { DatabaseModule } from '../database/database.module';
import { OperationalTimeService } from '../settings/operational-time.service';
import { MoneyAccountBalanceReadRepository } from './money-account-balance-read.repository';
import { MoneyMovementPostingRepository } from './money-movement-posting.repository';
import { MoneyMovementPostingService } from './money-movement-posting.service';

// S10.2 Money Movement Authority. This module exposes no controller: the posting authority
// is an internal, trusted primitive consumed by later S10 domain commands (opening balance,
// owner ledger, transfers, reversals) and future monetary Stations.
@Module({
  imports: [DatabaseModule, AccountingPeriodsModule],
  providers: [
    OperationalTimeService,
    MoneyMovementPostingRepository,
    MoneyMovementPostingService,
    MoneyAccountBalanceReadRepository,
  ],
  exports: [MoneyMovementPostingService, MoneyAccountBalanceReadRepository],
})
export class MoneyMovementsModule {}
