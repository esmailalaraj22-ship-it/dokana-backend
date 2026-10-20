import { Module } from '@nestjs/common';

import { AccountingCorrectionsModule } from './accounting-corrections/accounting-corrections.module';
import { AccountingPeriodsModule } from './accounting-periods/accounting-periods.module';
import { AuditModule } from './audit/audit.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { AuthenticationModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { LoggingModule } from './common/logging/logging.module';
import { ApplicationConfigModule } from './config/config.module';
import { CustomersModule } from './customers/customers.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DocumentsModule } from './documents/documents.module';
import { ExpensesModule } from './expenses/expenses.module';
import { HealthModule } from './health/health.module';
import { InventoryModule } from './inventory/inventory.module';
import { MoneyAccountsModule } from './money-accounts/money-accounts.module';
import { MoneyMovementsModule } from './money-movements/money-movements.module';
import { MoneyTransfersModule } from './money-transfers/money-transfers.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OfflineLicensesModule } from './offline-licenses/offline-licenses.module';
import { OwnerLedgerModule } from './owner-ledger/owner-ledger.module';
import { PlatformAuthorityModule } from './platform-authority/platform-authority.module';
import { ProductsModule } from './products/products.module';
import { ReportsModule } from './reports/reports.module';
import { RecoveryModule } from './recovery/recovery.module';
import { ReturnsModule } from './returns/returns.module';
import { SalesModule } from './sales/sales.module';
import { SearchModule } from './search/search.module';
import { SettingsModule } from './settings/settings.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    ApplicationConfigModule,
    LoggingModule,
    CommonModule,
    HealthModule,
    InventoryModule,
    AuthenticationModule,
    AuditModule,
    AttachmentsModule,
    AccountingPeriodsModule,
    AccountingCorrectionsModule,
    MoneyAccountsModule,
    MoneyMovementsModule,
    MoneyTransfersModule,
    NotificationsModule,
    OfflineLicensesModule,
    OwnerLedgerModule,
    PlatformAuthorityModule,
    CustomersModule,
    DashboardModule,
    DocumentsModule,
    ExpensesModule,
    ProductsModule,
    RecoveryModule,
    ReportsModule,
    ReturnsModule,
    SalesModule,
    SearchModule,
    SuppliersModule,
    SyncModule,
    SettingsModule,
  ],
})
export class AppModule {}
