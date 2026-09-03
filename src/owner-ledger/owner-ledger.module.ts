import { Module } from '@nestjs/common';

import { AccountingPeriodsModule } from '../accounting-periods/accounting-periods.module';
import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { MoneyMovementsModule } from '../money-movements/money-movements.module';
import { SettingsModule } from '../settings/settings.module';
import { OwnerLedgerController } from './owner-ledger.controller';
import { OwnerLedgerPostingRepository } from './owner-ledger-posting.repository';
import { OwnerLedgerWriteService } from './owner-ledger-write.service';
import { OwnerPositionReadRepository } from './owner-position-read.repository';
import { OwnerPositionReadService } from './owner-position-read.service';

@Module({
  imports: [
    AuthenticationModule,
    DatabaseModule,
    AccountingPeriodsModule,
    MoneyMovementsModule,
    SettingsModule,
  ],
  controllers: [OwnerLedgerController],
  providers: [
    OwnerLedgerPostingRepository,
    OwnerLedgerWriteService,
    OwnerPositionReadRepository,
    OwnerPositionReadService,
  ],
})
export class OwnerLedgerModule {}
