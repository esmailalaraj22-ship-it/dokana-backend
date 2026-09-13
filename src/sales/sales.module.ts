import { Module } from '@nestjs/common';

import { AccountingPeriodsModule } from '../accounting-periods/accounting-periods.module';
import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { MoneyMovementsModule } from '../money-movements/money-movements.module';
import { SettingsModule } from '../settings/settings.module';
import { SalePostingRepository } from './sale-posting.repository';
import { SalePostingService } from './sale-posting.service';
import { SaleReadRepository } from './sale-read.repository';
import { SaleReadService } from './sale-read.service';
import { SalesController } from './sales.controller';

@Module({
  imports: [
    AuthenticationModule,
    DatabaseModule,
    AccountingPeriodsModule,
    MoneyMovementsModule,
    SettingsModule,
  ],
  controllers: [SalesController],
  providers: [SalePostingRepository, SalePostingService, SaleReadRepository, SaleReadService],
})
export class SalesModule {}
