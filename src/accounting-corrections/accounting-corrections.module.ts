import { Module } from '@nestjs/common';

import { AccountingPeriodsModule } from '../accounting-periods/accounting-periods.module';
import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { MoneyMovementsModule } from '../money-movements/money-movements.module';
import { MoneyTransfersModule } from '../money-transfers/money-transfers.module';
import { OwnerLedgerModule } from '../owner-ledger/owner-ledger.module';
import { SettingsModule } from '../settings/settings.module';
import { AccountingCorrectionPostingRepository } from './accounting-correction-posting.repository';
import { AccountingCorrectionWriteService } from './accounting-correction-write.service';
import { MoneyTransferCorrectionController } from './money-transfer-correction.controller';
import { OwnerAccountingCorrectionController } from './owner-accounting-correction.controller';

@Module({
  imports: [
    AuthenticationModule,
    DatabaseModule,
    AccountingPeriodsModule,
    MoneyMovementsModule,
    MoneyTransfersModule,
    OwnerLedgerModule,
    SettingsModule,
  ],
  controllers: [OwnerAccountingCorrectionController, MoneyTransferCorrectionController],
  providers: [AccountingCorrectionPostingRepository, AccountingCorrectionWriteService],
})
export class AccountingCorrectionsModule {}
