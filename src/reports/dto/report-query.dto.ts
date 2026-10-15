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
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { REPORT_CURSOR_MAX_ENCODED_LENGTH } from '../report-cursor';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function parseStrictLimit(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) return value;
  return Number(value);
}

export class ReportPageQueryDto {
  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: 100,
    default: 50,
    description: 'Maximum rows in this bounded keyset page.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseStrictLimit(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    type: String,
    maxLength: REPORT_CURSOR_MAX_ENCODED_LENGTH,
    description:
      'Opaque Store- and filter-scope-bound continuation cursor returned by the preceding page. Reuse unchanged with identical filters.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(REPORT_CURSOR_MAX_ENCODED_LENGTH)
  cursor?: string;
}

export class ReportDateRangeQueryDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description:
      "Inclusive lower date bound, interpreted using the endpoint's response dateAuthority.",
  })
  @IsString()
  @Matches(datePattern)
  fromDate!: string;

  @ApiProperty({
    type: String,
    format: 'date',
    description:
      "Inclusive upper date bound, interpreted using the endpoint's response dateAuthority.",
  })
  @IsString()
  @Matches(datePattern)
  toDate!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Optional server-authoritative accounting-period filter.',
  })
  @IsOptional()
  @IsUUID()
  accountingPeriodId?: string;
}

export class ReportDateRangePageQueryDto extends ReportPageQueryDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description:
      "Inclusive lower date bound, interpreted using the endpoint's response dateAuthority.",
  })
  @IsString()
  @Matches(datePattern)
  fromDate!: string;

  @ApiProperty({
    type: String,
    format: 'date',
    description:
      "Inclusive upper date bound, interpreted using the endpoint's response dateAuthority.",
  })
  @IsString()
  @Matches(datePattern)
  toDate!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Optional server-authoritative accounting-period filter.',
  })
  @IsOptional()
  @IsUUID()
  accountingPeriodId?: string;
}

export class SalesReportQueryDto extends ReportDateRangePageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ enum: ['posted', 'cancelled', 'corrected', 'all'], default: 'all' })
  @IsOptional()
  @IsIn(['posted', 'cancelled', 'corrected', 'all'])
  status?: 'posted' | 'cancelled' | 'corrected' | 'all';
}

export class ExpenseReportQueryDto extends ReportDateRangePageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: ['posted', 'cancelled', 'all'], default: 'all' })
  @IsOptional()
  @IsIn(['posted', 'cancelled', 'all'])
  status?: 'posted' | 'cancelled' | 'all';
}

export class MoneyMovementReportQueryDto extends ReportDateRangePageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  moneyAccountId?: string;

  @ApiPropertyOptional({
    enum: [
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
    ],
  })
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
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
}

export class SupplierPayableReportQueryDto extends ReportPageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  supplierId?: string;
}

export class InventoryMovementReportQueryDto extends ReportDateRangePageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({
    enum: [
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
    ],
  })
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
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productId?: string;
}

export class ReturnsCorrectionsReportQueryDto extends ReportDateRangePageQueryDto {
  @ApiPropertyOptional({
    enum: [
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
    ],
    default: 'all',
  })
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
  @ApiPropertyOptional({
    enum: [
      'capital_contribution',
      'owner_loan_to_store',
      'owner_paid_expense',
      'owner_paid_supplier',
      'owner_reimbursement',
      'personal_withdrawal',
      'profit_withdrawal',
      'capital_withdrawal',
      'correction',
    ],
  })
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
  @ApiPropertyOptional({ enum: ['cash', 'transfer'] })
  @IsOptional()
  @IsIn(['cash', 'transfer'])
  accountType?: 'cash' | 'transfer';
}
