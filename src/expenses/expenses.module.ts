import { Module } from '@nestjs/common';

import { AccountingPeriodsModule } from '../accounting-periods/accounting-periods.module';
import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { MoneyMovementsModule } from '../money-movements/money-movements.module';
import { OwnerLedgerModule } from '../owner-ledger/owner-ledger.module';
import { SettingsModule } from '../settings/settings.module';
import { ExpenseCategoryRepository } from './expense-category.repository';
import { ExpenseCategoryService } from './expense-category.service';
import { ExpensePaymentRepository } from './expense-payment.repository';
import { ExpensePaymentService } from './expense-payment.service';
import { ExpenseReadRepository } from './expense-read.repository';
import { ExpenseReadService } from './expense-read.service';
import { ExpenseRecognitionRepository } from './expense-recognition.repository';
import { ExpenseRecognitionService } from './expense-recognition.service';
import { ExpensesController } from './expenses.controller';

@Module({
  imports: [
    AuthenticationModule,
    DatabaseModule,
    AccountingPeriodsModule,
    MoneyMovementsModule,
    OwnerLedgerModule,
    SettingsModule,
  ],
  controllers: [ExpensesController],
  providers: [
    ExpenseCategoryRepository,
    ExpenseCategoryService,
    ExpensePaymentRepository,
    ExpensePaymentService,
    ExpenseReadRepository,
    ExpenseReadService,
    ExpenseRecognitionRepository,
    ExpenseRecognitionService,
  ],
})
export class ExpensesModule {}
