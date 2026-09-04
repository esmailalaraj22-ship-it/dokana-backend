import { Module } from '@nestjs/common';

import { AccountingPeriodsModule } from '../accounting-periods/accounting-periods.module';
import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { MoneyMovementsModule } from '../money-movements/money-movements.module';
import { SettingsModule } from '../settings/settings.module';
import { MoneyTransferPostingRepository } from './money-transfer-posting.repository';
import { MoneyTransferController } from './money-transfer.controller';
import { MoneyTransferWriteService } from './money-transfer-write.service';

@Module({
  imports: [
    AuthenticationModule,
    DatabaseModule,
    AccountingPeriodsModule,
    MoneyMovementsModule,
    SettingsModule,
  ],
  controllers: [MoneyTransferController],
  providers: [MoneyTransferPostingRepository, MoneyTransferWriteService],
  exports: [MoneyTransferPostingRepository],
})
export class MoneyTransfersModule {}
