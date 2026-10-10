import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { AccountingCorrectionsModule } from '../accounting-corrections/accounting-corrections.module';
import { CustomersModule } from '../customers/customers.module';
import { DatabaseModule } from '../database/database.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MoneyTransfersModule } from '../money-transfers/money-transfers.module';
import { OfflineLicensesModule } from '../offline-licenses/offline-licenses.module';
import { OwnerLedgerModule } from '../owner-ledger/owner-ledger.module';
import { ProductsModule } from '../products/products.module';
import { ReturnsModule } from '../returns/returns.module';
import { SalesModule } from '../sales/sales.module';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { BOOTSTRAP_ARTIFACT_ROOT, BootstrapArtifactStore } from './bootstrap-artifact.store';
import { BootstrapController } from './bootstrap.controller';
import { BootstrapRepository } from './bootstrap.repository';
import { BootstrapService } from './bootstrap.service';
import { OfflineOperationController } from './offline-operation.controller';
import { OfflineOperationRegistry } from './offline-operation.registry';
import { OfflineOperationRepository } from './offline-operation.repository';
import { OfflineOperationService } from './offline-operation.service';

@Module({
  imports: [
    AccountingCorrectionsModule,
    AuthenticationModule,
    CustomersModule,
    DatabaseModule,
    ExpensesModule,
    InventoryModule,
    MoneyTransfersModule,
    OfflineLicensesModule,
    OwnerLedgerModule,
    ProductsModule,
    ReturnsModule,
    SalesModule,
    SuppliersModule,
  ],
  controllers: [BootstrapController, OfflineOperationController],
  providers: [
    {
      provide: BOOTSTRAP_ARTIFACT_ROOT,
      useFactory: () => join(tmpdir(), 'dokana-bootstrap-v1'),
    },
    BootstrapArtifactStore,
    BootstrapRepository,
    BootstrapService,
    OfflineOperationRegistry,
    OfflineOperationRepository,
    OfflineOperationService,
  ],
})
export class SyncModule {}
