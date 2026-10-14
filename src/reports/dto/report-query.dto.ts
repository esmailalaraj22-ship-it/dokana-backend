import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { REPORT_CURSOR_MAX_ENCODED_LENGTH } from '../report-cursor';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function parseStrictLimit(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) return value;
  return Number(value);
}

export class ReportPageQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseStrictLimit(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(REPORT_CURSOR_MAX_ENCODED_LENGTH)
  cursor?: string;
}

export class ReportDateRangeQueryDto {
  @IsString()
  @Matches(datePattern)
  fromDate!: string;

  @IsString()
  @Matches(datePattern)
  toDate!: string;

  @IsOptional()
  @IsUUID()
  accountingPeriodId?: string;
}

export class ReportDateRangePageQueryDto extends ReportPageQueryDto {
  @IsString()
  @Matches(datePattern)
  fromDate!: string;

  @IsString()
  @Matches(datePattern)
  toDate!: string;

  @IsOptional()
  @IsUUID()
  accountingPeriodId?: string;
}

export class SalesReportQueryDto extends ReportDateRangePageQueryDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsIn(['posted', 'cancelled', 'corrected', 'all'])
  status?: 'posted' | 'cancelled' | 'corrected' | 'all';
}

export class ExpenseReportQueryDto extends ReportDateRangePageQueryDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsIn(['posted', 'cancelled', 'all'])
  status?: 'posted' | 'cancelled' | 'all';
}

export class MoneyMovementReportQueryDto extends ReportDateRangePageQueryDto {
  @IsOptional()
  @IsUUID()
  moneyAccountId?: string;

  @IsOptional()
  @IsIn([
    'opening_balance',
    'sale_payment',
    'customer_payment',
    'supplier_payment',
    'expense_payment',
    'owner_contribution',
    'owner_loan',
    'owner_reimbursement',
    'owner_withdrawal',
    'internal_transfer',
    'customer_refund',
    'supplier_refund',
    'correction',
    'other',
  ])
  movementType?: string;
}

export class CustomerReceivableReportQueryDto extends ReportPageQueryDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;
}

export class SupplierPayableReportQueryDto extends ReportPageQueryDto {
  @IsOptional()
  @IsUUID()
  supplierId?: string;
}

export class InventoryMovementReportQueryDto extends ReportDateRangePageQueryDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsIn([
    'opening_balance',
    'purchase_receipt',
    'sale',
    'customer_return_saleable',
    'supplier_return',
    'adjustment_in',
    'adjustment_out',
    'stock_count',
    'correction',
    'owner_use',
    'gift',
    'damage',
    'loss',
    'expiry',
  ])
  movementType?: string;
}

export class InventoryStockReportQueryDto extends ReportPageQueryDto {
  @IsOptional()
  @IsUUID()
  productId?: string;
}

export class ReturnsCorrectionsReportQueryDto extends ReportDateRangePageQueryDto {
  @IsOptional()
  @IsIn([
    'sale_return',
    'supplier_return',
    'sale_correction',
    'supplier_invoice_correction',
    'customer_payment_correction',
    'supplier_payment_correction',
    'expense_payment_correction',
    'expense_correction',
    'money_correction',
    'inventory_correction',
    'owner_correction',
    'all',
  ])
  sourceType?: string;
}

export class OwnerLedgerReportQueryDto extends ReportDateRangePageQueryDto {
  @IsOptional()
  @IsIn([
    'capital_contribution',
    'owner_loan_to_store',
    'owner_paid_expense',
    'owner_paid_supplier',
    'owner_reimbursement',
    'personal_withdrawal',
    'profit_withdrawal',
    'capital_withdrawal',
    'correction',
  ])
  entryType?: string;
}

export class LiquidityReportQueryDto extends ReportPageQueryDto {
  @IsOptional()
  @IsIn(['cash', 'transfer'])
  accountType?: 'cash' | 'transfer';
}
