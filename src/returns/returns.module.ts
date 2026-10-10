import { Module } from '@nestjs/common';

import { AccountingPeriodsModule } from '../accounting-periods/accounting-periods.module';
import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MoneyMovementsModule } from '../money-movements/money-movements.module';
import { SalesModule } from '../sales/sales.module';
import { SettingsModule } from '../settings/settings.module';
import { ReturnsController } from './returns.controller';
import { SaleReturnCorrectionRepository } from './sale-return-correction.repository';
import { SaleReturnCorrectionService } from './sale-return-correction.service';
import { SaleReturnAuthorityRepository } from './sale-return-authority.repository';
import { SaleReturnPostingRepository } from './sale-return-posting.repository';
import { SaleReturnPostingService } from './sale-return-posting.service';
import { SaleReturnReadRepository } from './sale-return-read.repository';
import { SaleReturnReadService } from './sale-return-read.service';

@Module({
  imports: [
    AuthenticationModule,
    DatabaseModule,
    AccountingPeriodsModule,
    SettingsModule,
    InventoryModule,
    MoneyMovementsModule,
    SalesModule,
  ],
  controllers: [ReturnsController],
  providers: [
    SaleReturnCorrectionRepository,
    SaleReturnCorrectionService,
    SaleReturnAuthorityRepository,
    SaleReturnPostingRepository,
    SaleReturnPostingService,
    SaleReturnReadRepository,
    SaleReturnReadService,
  ],
  exports: [SaleReturnCorrectionService, SaleReturnPostingService],
})
export class ReturnsModule {}
