import { Module } from '@nestjs/common';

import { AccountingPeriodsModule } from '../accounting-periods/accounting-periods.module';
import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { MoneyMovementsModule } from '../money-movements/money-movements.module';
import { OwnerLedgerModule } from '../owner-ledger/owner-ledger.module';
import { SettingsModule } from '../settings/settings.module';
import { SupplierFinancialReadRepository } from './supplier-financial-read.repository';
import { SupplierFinancialReadService } from './supplier-financial-read.service';
import { SupplierReadRepository } from './supplier-read.repository';
import { SupplierReadService } from './supplier-read.service';
import { SupplierInvoiceCorrectionRepository } from './supplier-invoice-correction.repository';
import { SupplierInvoiceCorrectionService } from './supplier-invoice-correction.service';
import { SupplierInvoicePostingRepository } from './supplier-invoice-posting.repository';
import { SupplierInvoicePostingService } from './supplier-invoice-posting.service';
import { SupplierPaymentPostingRepository } from './supplier-payment-posting.repository';
import { SupplierPaymentPostingService } from './supplier-payment-posting.service';
import { SupplierPaymentCorrectionRepository } from './supplier-payment-correction.repository';
import { SupplierPaymentCorrectionService } from './supplier-payment-correction.service';
import { SupplierPaymentReadService } from './supplier-payment-read.service';
import { SuppliersController } from './suppliers.controller';
import { SupplierWriteRepository } from './supplier-write.repository';
import { SupplierWriteService } from './supplier-write.service';

@Module({
  imports: [
    AuthenticationModule,
    DatabaseModule,
    AccountingPeriodsModule,
    MoneyMovementsModule,
    OwnerLedgerModule,
    SettingsModule,
  ],
  controllers: [SuppliersController],
  providers: [
    SupplierFinancialReadRepository,
    SupplierFinancialReadService,
    SupplierInvoiceCorrectionRepository,
    SupplierInvoiceCorrectionService,
    SupplierInvoicePostingRepository,
    SupplierInvoicePostingService,
    SupplierPaymentPostingRepository,
    SupplierPaymentPostingService,
    SupplierPaymentCorrectionRepository,
    SupplierPaymentCorrectionService,
    SupplierPaymentReadService,
    SupplierReadRepository,
    SupplierReadService,
    SupplierWriteRepository,
    SupplierWriteService,
  ],
})
export class SuppliersModule {}
