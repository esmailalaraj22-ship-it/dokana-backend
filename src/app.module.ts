import { Module } from '@nestjs/common';

import { AccountingCorrectionsModule } from './accounting-corrections/accounting-corrections.module';
import { AccountingPeriodsModule } from './accounting-periods/accounting-periods.module';
import { AuthenticationModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { LoggingModule } from './common/logging/logging.module';
import { ApplicationConfigModule } from './config/config.module';
import { CustomersModule } from './customers/customers.module';
import { ExpensesModule } from './expenses/expenses.module';
import { HealthModule } from './health/health.module';
import { InventoryModule } from './inventory/inventory.module';
import { MoneyAccountsModule } from './money-accounts/money-accounts.module';
import { MoneyMovementsModule } from './money-movements/money-movements.module';
import { MoneyTransfersModule } from './money-transfers/money-transfers.module';
import { OwnerLedgerModule } from './owner-ledger/owner-ledger.module';
import { PlatformAuthorityModule } from './platform-authority/platform-authority.module';
import { ProductsModule } from './products/products.module';
import { ReturnsModule } from './returns/returns.module';
import { SalesModule } from './sales/sales.module';
import { SettingsModule } from './settings/settings.module';
import { SuppliersModule } from './suppliers/suppliers.module';

@Module({
  imports: [
    ApplicationConfigModule,
    LoggingModule,
    CommonModule,
    HealthModule,
    InventoryModule,
    AuthenticationModule,
    AccountingPeriodsModule,
    AccountingCorrectionsModule,
    MoneyAccountsModule,
    MoneyMovementsModule,
    MoneyTransfersModule,
    OwnerLedgerModule,
    PlatformAuthorityModule,
    CustomersModule,
    ExpensesModule,
    ProductsModule,
    ReturnsModule,
    SalesModule,
    SuppliersModule,
    SettingsModule,
  ],
})
export class AppModule {}
