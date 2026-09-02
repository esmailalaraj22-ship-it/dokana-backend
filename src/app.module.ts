import { Module } from '@nestjs/common';

import { AccountingPeriodsModule } from './accounting-periods/accounting-periods.module';
import { AuthenticationModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { LoggingModule } from './common/logging/logging.module';
import { ApplicationConfigModule } from './config/config.module';
import { CustomersModule } from './customers/customers.module';
import { HealthModule } from './health/health.module';
import { MoneyAccountsModule } from './money-accounts/money-accounts.module';
import { ProductsModule } from './products/products.module';
import { SettingsModule } from './settings/settings.module';
import { SuppliersModule } from './suppliers/suppliers.module';

@Module({
  imports: [
    ApplicationConfigModule,
    LoggingModule,
    CommonModule,
    HealthModule,
    AuthenticationModule,
    AccountingPeriodsModule,
    MoneyAccountsModule,
    CustomersModule,
    ProductsModule,
    SuppliersModule,
    SettingsModule,
  ],
})
export class AppModule {}
