import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { InventoryCostState, ReturnStatus, SaleStatus } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import type {
  MoneyAccountPhysicalType,
  MoneyAccountStatus,
} from '../money-accounts/money-account.types';
import {
  allocateHistoricalLineNetValues,
  cumulativeProportionalAmount,
} from './sale-return-policy';
import { parseStoredSaleReturnPostingResponse } from './sale-return-posting-response';
import type {
  SaleReturnPostingResponse,
  SaleReturnSettlementKind,
} from './sale-return-posting.types';
import { SaleReturnReadQueryError } from './sale-return-read-query-error';
import type {
  SaleReturnCustomerLedgerEffectRow,
  SaleReturnDetailRow,
  SaleReturnEligibilityRow,
  SaleReturnInventoryEffectRow,
  SaleReturnLineReadRow,
  SaleReturnListCriteria,
  SaleReturnMoneyAccountRow,
  SaleReturnMoneyRefundEffectRow,
  SaleReturnReadCustomerRow,
  SaleReturnReadPosition,
  SaleReturnSettlementReadRow,
  SaleReturnSummaryRow,
} from './sale-return-read.types';

interface SummaryPhysicalRow extends Record<string, unknown> {
  id: string;
  saleId: string;
  saleDisplayNumber: string;
  saleAt: string;
  saleStatus: SaleStatus;
  saleCorrectionOfId: string | null;
  saleReversedById: string | null;
  saleCustomerId: string | null;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerStatus: 'active' | 'archived' | null;
  customerArchivedAt: string | null;
  accountingPeriodId: string | null;
  displayNumber: string;
  returnAt: string;
  totalMinor: string;
  status: ReturnStatus;
  reason: string | null;
  cancelledAt: string | null;
  operationId: string;
  createdAt: string;
  updatedAt: string;
  version: string;
  postingResponse: unknown;
  lineCount: number;
  lineTotalMinor: string;
  restockSaleableLineCount: number;
  damagedNoRestockLineCount: number;
  noInventoryEffectLineCount: number;
  receivableReductionMinor: string;
  originalCreditRestorationMinor: string;
  newCustomerCreditMinor: string;
  refundMinor: string;
  settlementTotalMinor: string;
}

interface PositionPhysicalRow extends Record<string, unknown> {
  id: string;
  returnAt: string;
}

interface LinePhysicalRow extends Record<string, unknown> {
  id: string;
  saleReturnId: string;
  saleItemId: string;
  saleId: string;
  productId: string | null;
  productUnitId: string | null;
  isManualLine: boolean;
  productNameSnapshot: string;
  unitNameSnapshot: string | null;
  productStatus: 'active' | 'archived' | null;
  productUnitStatus: 'active' | 'archived' | null;
  quantityMilli: string;
  baseQuantityMilli: string | null;
  lineRefundMinor: string;
  itemCondition: 'saleable' | 'damaged';
  inventoryMovementId: string | null;
  inventoryOperationId: string | null;
  inventoryProductId: string | null;
  inventoryProductUnitId: string | null;
  inventoryMovementType: 'customer_return_saleable' | null;
  inventoryQuantityDeltaMilli: string | null;
  inventoryValueDeltaMinor: string | null;
  inventoryCostStatus: InventoryCostState | null;
  inventoryReferenceType: string | null;
  inventoryReferenceId: string | null;
  inventoryTransactionGroupId: string | null;
  inventoryOccurredAt: string | null;
  inventoryBusinessDate: string | null;
  inventoryPostingDate: string | null;
}

interface SettlementPhysicalRow extends Record<string, unknown> {
  id: string;
  saleReturnId: string;
  settlementType: 'reduce_receivable' | 'customer_credit' | 'money_refund';
  amountMinor: string;
  moneyAccountId: string | null;
  moneyAccountName: string | null;
  moneyAccountType: MoneyAccountPhysicalType | null;
  moneyAccountStatus: MoneyAccountStatus | null;
  moneyMovementId: string | null;
  moneyMovementOperationId: string | null;
  moneyMovementAmountDeltaMinor: string | null;
  moneyMovementType: 'customer_refund' | null;
  moneyMovementReferenceType: string | null;
  moneyMovementReferenceId: string | null;
  moneyMovementTransactionGroupId: string | null;
  moneyMovementOccurredAt: string | null;
  customerLedgerEntryId: string | null;
  customerLedgerOperationId: string | null;
  customerLedgerEntryType: 'return' | 'credit_created' | null;
  customerLedgerReceivableDeltaMinor: string | null;
  customerLedgerCreditDeltaMinor: string | null;
  customerLedgerSourceSaleId: string | null;
  customerLedgerReferenceType: string | null;
  customerLedgerReferenceId: string | null;
  customerLedgerTransactionGroupId: string | null;
  customerLedgerOccurredAt: string | null;
}

interface EligibilityPhysicalRow extends Record<string, unknown> {
  saleId: string;
  saleDisplayNumber: string;
  saleAt: string;
  saleTotalMinor: string;
  saleStatus: SaleStatus;
  saleReversedById: string | null;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerStatus: 'active' | 'archived' | null;
  customerArchivedAt: string | null;
  acceptedAt: string;
  saleItemId: string;
  productId: string | null;
  productUnitId: string | null;
  isManualLine: boolean;
  productNameSnapshot: string;
  unitNameSnapshot: string | null;
  quantityMilli: string;
  lineTotalMinor: string;
  inventoryMovementId: string | null;
  productStatus: 'active' | 'archived' | null;
  productTracksInventory: boolean | null;
  productUnitStatus: 'active' | 'archived' | null;
  returnedQuantityMilli: string;
}

@Injectable()
export class SaleReturnReadRepository {
  constructor(private readonly database: DatabaseService) {}

  list(
    context: TenantTransactionContext,
    criteria: SaleReturnListCriteria,
  ): Promise<SaleReturnSummaryRow[]> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const position = criteria.anchor
        ? await this.resolvePosition(transaction, context.storeId, criteria)
        : null;
      const continuation = position
        ? sql`and (
            return_root.return_at < ${position.returnAt}
            or (return_root.return_at = ${position.returnAt} and return_root.id < ${position.id}::uuid)
          )`
        : sql``;
      const saleScope = criteria.saleId
        ? sql`and return_root.sale_id = ${criteria.saleId}::uuid`
        : sql``;
      const result = await transaction.execute<SummaryPhysicalRow>(sql`
        select
          return_root.id,
          return_root.sale_id as "saleId",
          sale.display_number as "saleDisplayNumber",
          sale.sale_at as "saleAt",
          sale.status as "saleStatus",
          sale.correction_of_id as "saleCorrectionOfId",
          sale.reversed_by_id as "saleReversedById",
          sale.customer_id as "saleCustomerId",
          return_root.customer_id as "customerId",
          customer.name as "customerName",
          customer.phone as "customerPhone",
          customer.status as "customerStatus",
          customer.archived_at as "customerArchivedAt",
          return_root.accounting_period_id as "accountingPeriodId",
          return_root.display_number as "displayNumber",
          return_root.return_at as "returnAt",
          return_root.total_minor::text as "totalMinor",
          return_root.status,
          return_root.notes as reason,
          return_root.cancelled_at as "cancelledAt",
          return_root.operation_id as "operationId",
          return_root.created_at as "createdAt",
          return_root.updated_at as "updatedAt",
          return_root.version::text as version,
          operation.response_body as "postingResponse",
          line_summary."lineCount",
          line_summary."lineTotalMinor",
          line_summary."restockSaleableLineCount",
          line_summary."damagedNoRestockLineCount",
          line_summary."noInventoryEffectLineCount",
          settlement_summary."receivableReductionMinor",
          settlement_summary."originalCreditRestorationMinor",
          settlement_summary."newCustomerCreditMinor",
          settlement_summary."refundMinor",
          settlement_summary."settlementTotalMinor"
        from ledger.sale_returns return_root
        join ledger.sales sale
          on sale.store_id=return_root.store_id and sale.id=return_root.sale_id
        left join ledger.customers customer
          on customer.store_id=return_root.store_id and customer.id=return_root.customer_id
        join sync.processed_operations operation
          on operation.store_id=return_root.store_id
         and operation.operation_id=return_root.operation_id
         and operation.aggregate_type='sale_returns'
         and operation.aggregate_id=return_root.id
         and operation.action='sale_returns.post'
         and operation.status='applied'
        cross join lateral (
          select count(*)::int as "lineCount",
            coalesce(sum(item.line_refund_minor),0)::text as "lineTotalMinor",
            count(*) filter(where item.item_condition='saleable')::int
              as "restockSaleableLineCount",
            count(*) filter(where item.item_condition='damaged')::int
              as "damagedNoRestockLineCount",
            count(*) filter(where item.inventory_movement_id is null)::int
              as "noInventoryEffectLineCount"
          from ledger.sale_return_items item
          where item.store_id=return_root.store_id and item.sale_return_id=return_root.id
        ) line_summary
        cross join lateral (
          select
            coalesce(sum(settlement.amount_minor) filter(
              where settlement.settlement_type='reduce_receivable'),0)::text
              as "receivableReductionMinor",
            coalesce(sum(settlement.amount_minor) filter(
              where settlement.settlement_type='customer_credit'
                and customer_effect.reference_type='sale_return_original_credit_restoration'),0)::text
              as "originalCreditRestorationMinor",
            coalesce(sum(settlement.amount_minor) filter(
              where settlement.settlement_type='customer_credit'
                and customer_effect.reference_type='sale_return'),0)::text
              as "newCustomerCreditMinor",
            coalesce(sum(settlement.amount_minor) filter(
              where settlement.settlement_type='money_refund'),0)::text as "refundMinor",
            coalesce(sum(settlement.amount_minor),0)::text as "settlementTotalMinor"
          from ledger.sale_return_settlements settlement
          left join ledger.customer_ledger_entries customer_effect
            on customer_effect.store_id=settlement.store_id
           and customer_effect.id=settlement.customer_ledger_entry_id
          where settlement.store_id=return_root.store_id
            and settlement.sale_return_id=return_root.id
        ) settlement_summary
        where return_root.store_id=${context.storeId}::uuid
          and return_root.status <> 'draft'
          ${saleScope}
          ${continuation}
        order by return_root.return_at desc, return_root.id desc
        limit ${criteria.limit + 1}
      `);
      return result.rows.map((row) => this.mapSummary(row));
    });
  }

  findById(
    context: TenantTransactionContext,
    returnId: string,
  ): Promise<SaleReturnDetailRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const headerResult = await transaction.execute<SummaryPhysicalRow>(sql`
        select
          return_root.id,
          return_root.sale_id as "saleId",
          sale.display_number as "saleDisplayNumber",
          sale.sale_at as "saleAt",
          sale.status as "saleStatus",
          sale.correction_of_id as "saleCorrectionOfId",
          sale.reversed_by_id as "saleReversedById",
          sale.customer_id as "saleCustomerId",
          return_root.customer_id as "customerId",
          customer.name as "customerName",
          customer.phone as "customerPhone",
          customer.status as "customerStatus",
          customer.archived_at as "customerArchivedAt",
          return_root.accounting_period_id as "accountingPeriodId",
          return_root.display_number as "displayNumber",
          return_root.return_at as "returnAt",
          return_root.total_minor::text as "totalMinor",
          return_root.status,
          return_root.notes as reason,
          return_root.cancelled_at as "cancelledAt",
          return_root.operation_id as "operationId",
          return_root.created_at as "createdAt",
          return_root.updated_at as "updatedAt",
          return_root.version::text as version,
          operation.response_body as "postingResponse",
          line_summary."lineCount",
          line_summary."lineTotalMinor",
          line_summary."restockSaleableLineCount",
          line_summary."damagedNoRestockLineCount",
          line_summary."noInventoryEffectLineCount",
          settlement_summary."receivableReductionMinor",
          settlement_summary."originalCreditRestorationMinor",
          settlement_summary."newCustomerCreditMinor",
          settlement_summary."refundMinor",
          settlement_summary."settlementTotalMinor"
        from ledger.sale_returns return_root
        join ledger.sales sale
          on sale.store_id=return_root.store_id and sale.id=return_root.sale_id
        left join ledger.customers customer
          on customer.store_id=return_root.store_id and customer.id=return_root.customer_id
        join sync.processed_operations operation
          on operation.store_id=return_root.store_id
         and operation.operation_id=return_root.operation_id
         and operation.aggregate_type='sale_returns'
         and operation.aggregate_id=return_root.id
         and operation.action='sale_returns.post'
         and operation.status='applied'
        cross join lateral (
          select count(*)::int as "lineCount",
            coalesce(sum(item.line_refund_minor),0)::text as "lineTotalMinor",
            count(*) filter(where item.item_condition='saleable')::int
              as "restockSaleableLineCount",
            count(*) filter(where item.item_condition='damaged')::int
              as "damagedNoRestockLineCount",
            count(*) filter(where item.inventory_movement_id is null)::int
              as "noInventoryEffectLineCount"
          from ledger.sale_return_items item
          where item.store_id=return_root.store_id and item.sale_return_id=return_root.id
        ) line_summary
        cross join lateral (
          select
            coalesce(sum(settlement.amount_minor) filter(
              where settlement.settlement_type='reduce_receivable'),0)::text
              as "receivableReductionMinor",
            coalesce(sum(settlement.amount_minor) filter(
              where settlement.settlement_type='customer_credit'
                and customer_effect.reference_type='sale_return_original_credit_restoration'),0)::text
              as "originalCreditRestorationMinor",
            coalesce(sum(settlement.amount_minor) filter(
              where settlement.settlement_type='customer_credit'
                and customer_effect.reference_type='sale_return'),0)::text
              as "newCustomerCreditMinor",
            coalesce(sum(settlement.amount_minor) filter(
              where settlement.settlement_type='money_refund'),0)::text as "refundMinor",
            coalesce(sum(settlement.amount_minor),0)::text as "settlementTotalMinor"
          from ledger.sale_return_settlements settlement
          left join ledger.customer_ledger_entries customer_effect
            on customer_effect.store_id=settlement.store_id
           and customer_effect.id=settlement.customer_ledger_entry_id
          where settlement.store_id=return_root.store_id
            and settlement.sale_return_id=return_root.id
        ) settlement_summary
        where return_root.store_id=${context.storeId}::uuid
          and return_root.id=${returnId}::uuid
          and return_root.status <> 'draft'
        for share of return_root
      `);
      const header = headerResult.rows[0];
      if (!header) return undefined;

      const [lineResult, settlementResult] = await Promise.all([
        transaction.execute<LinePhysicalRow>(sql`
          select item.id,item.sale_return_id as "saleReturnId",item.sale_item_id as "saleItemId",
            sale_item.sale_id as "saleId",sale_item.product_id as "productId",
            sale_item.product_unit_id as "productUnitId",sale_item.is_manual_line as "isManualLine",
            sale_item.product_name_snapshot as "productNameSnapshot",
            sale_item.unit_name_snapshot as "unitNameSnapshot",
            product.status as "productStatus",product_unit.status as "productUnitStatus",
            item.quantity_milli::text as "quantityMilli",
            item.base_quantity_milli::text as "baseQuantityMilli",
            item.line_refund_minor::text as "lineRefundMinor",item.item_condition as "itemCondition",
            movement.id as "inventoryMovementId",movement.operation_id as "inventoryOperationId",
            movement.product_id as "inventoryProductId",
            movement.product_unit_id as "inventoryProductUnitId",
            movement.movement_type as "inventoryMovementType",
            movement.quantity_delta_milli::text as "inventoryQuantityDeltaMilli",
            movement.value_delta_minor::text as "inventoryValueDeltaMinor",
            movement.cost_status as "inventoryCostStatus",
            movement.reference_type as "inventoryReferenceType",
            movement.reference_id as "inventoryReferenceId",
            movement.transaction_group_id as "inventoryTransactionGroupId",
            movement.occurred_at as "inventoryOccurredAt",
            movement.business_date::text as "inventoryBusinessDate",
            movement.posting_date::text as "inventoryPostingDate"
          from ledger.sale_return_items item
          join ledger.sale_items sale_item
            on sale_item.store_id=item.store_id and sale_item.id=item.sale_item_id
          left join ledger.products product
            on product.store_id=sale_item.store_id and product.id=sale_item.product_id
          left join ledger.product_units product_unit
            on product_unit.store_id=sale_item.store_id
           and product_unit.id=sale_item.product_unit_id
          left join ledger.inventory_movements movement
            on movement.store_id=item.store_id and movement.id=item.inventory_movement_id
          where item.store_id=${context.storeId}::uuid and item.sale_return_id=${returnId}::uuid
          order by item.id
        `),
        transaction.execute<SettlementPhysicalRow>(sql`
          select settlement.id,settlement.sale_return_id as "saleReturnId",
            settlement.settlement_type as "settlementType",
            settlement.amount_minor::text as "amountMinor",
            settlement.money_account_id as "moneyAccountId",account.name as "moneyAccountName",
            account.account_type as "moneyAccountType",account.status as "moneyAccountStatus",
            movement.id as "moneyMovementId",movement.operation_id as "moneyMovementOperationId",
            movement.amount_delta_minor::text as "moneyMovementAmountDeltaMinor",
            movement.movement_type as "moneyMovementType",
            movement.reference_type as "moneyMovementReferenceType",
            movement.reference_id as "moneyMovementReferenceId",
            movement.transaction_group_id as "moneyMovementTransactionGroupId",
            movement.occurred_at as "moneyMovementOccurredAt",
            customer_effect.id as "customerLedgerEntryId",
            customer_effect.operation_id as "customerLedgerOperationId",
            customer_effect.entry_type as "customerLedgerEntryType",
            customer_effect.receivable_delta_minor::text as "customerLedgerReceivableDeltaMinor",
            customer_effect.credit_delta_minor::text as "customerLedgerCreditDeltaMinor",
            customer_effect.source_sale_id as "customerLedgerSourceSaleId",
            customer_effect.reference_type as "customerLedgerReferenceType",
            customer_effect.reference_id as "customerLedgerReferenceId",
            customer_effect.transaction_group_id as "customerLedgerTransactionGroupId",
            customer_effect.occurred_at as "customerLedgerOccurredAt"
          from ledger.sale_return_settlements settlement
          left join ledger.customer_ledger_entries customer_effect
            on customer_effect.store_id=settlement.store_id
           and customer_effect.id=settlement.customer_ledger_entry_id
          left join ledger.money_movements movement
            on movement.store_id=settlement.store_id and movement.id=settlement.money_movement_id
          left join ledger.money_accounts account
            on account.store_id=settlement.store_id and account.id=settlement.money_account_id
          where settlement.store_id=${context.storeId}::uuid
            and settlement.sale_return_id=${returnId}::uuid
          order by settlement.id
        `),
      ]);
      const summary = this.mapSummary(header);
      const lines = lineResult.rows.map((row) => this.mapLine(row, summary));
      const settlements = settlementResult.rows.map((row) => this.mapSettlement(row, summary));
      this.assertDetailIntegrity(summary, lines, settlements);
      return { ...summary, lines, settlements };
    });
  }

  findEligibility(
    context: TenantTransactionContext,
    saleId: string,
  ): Promise<SaleReturnEligibilityRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const result = await transaction.execute<EligibilityPhysicalRow>(sql`
        select sale.id as "saleId",sale.display_number as "saleDisplayNumber",
          sale.sale_at as "saleAt",sale.total_minor::text as "saleTotalMinor",
          sale.status as "saleStatus",sale.reversed_by_id as "saleReversedById",
          sale.customer_id as "customerId",customer.name as "customerName",
          customer.phone as "customerPhone",customer.status as "customerStatus",
          customer.archived_at as "customerArchivedAt",
          transaction_timestamp()::text as "acceptedAt",
          item.id as "saleItemId",item.product_id as "productId",
          item.product_unit_id as "productUnitId",item.is_manual_line as "isManualLine",
          item.product_name_snapshot as "productNameSnapshot",
          item.unit_name_snapshot as "unitNameSnapshot",
          item.quantity_milli::text as "quantityMilli",
          item.line_total_minor::text as "lineTotalMinor",
          item.inventory_movement_id as "inventoryMovementId",
          product.status as "productStatus",product.track_inventory as "productTracksInventory",
          product_unit.status as "productUnitStatus",
          coalesce((
            select sum(return_item.quantity_milli)
            from ledger.sale_return_items return_item
            join ledger.sale_returns return_root
              on return_root.store_id=return_item.store_id
             and return_root.id=return_item.sale_return_id
            where return_item.store_id=sale.store_id
              and return_root.sale_id=sale.id
              and return_root.status='posted'
              and return_item.sale_item_id=item.id
          ),0)::text as "returnedQuantityMilli"
        from ledger.sales sale
        join ledger.sale_items item on item.store_id=sale.store_id and item.sale_id=sale.id
        left join ledger.customers customer
          on customer.store_id=sale.store_id and customer.id=sale.customer_id
        left join ledger.products product
          on product.store_id=item.store_id and product.id=item.product_id
        left join ledger.product_units product_unit
          on product_unit.store_id=item.store_id and product_unit.id=item.product_unit_id
        where sale.store_id=${context.storeId}::uuid
          and sale.id=${saleId}::uuid
          and sale.status <> 'draft'
        order by item.id
      `);
      const first = result.rows[0];
      if (!first) return undefined;
      const customer = this.mapEligibilityCustomer(first);
      const historicalValues = allocateHistoricalLineNetValues(
        result.rows.map((row) => ({
          saleItemId: row.saleItemId,
          lineTotalMinor: BigInt(row.lineTotalMinor),
        })),
        BigInt(first.saleTotalMinor),
      );
      return {
        saleId: first.saleId,
        saleDisplayNumber: first.saleDisplayNumber,
        saleAt: new Date(first.saleAt),
        saleStatus: first.saleStatus,
        saleReversedById: first.saleReversedById,
        customer,
        acceptedAt: new Date(first.acceptedAt),
        lines: result.rows.map((row) => {
          const originalQuantityMilli = BigInt(row.quantityMilli);
          const returnedQuantityMilli = BigInt(row.returnedQuantityMilli);
          const historicalNetValueMinor = historicalValues.get(row.saleItemId);
          if (
            historicalNetValueMinor === undefined ||
            originalQuantityMilli <= 0n ||
            returnedQuantityMilli < 0n ||
            returnedQuantityMilli > originalQuantityMilli
          ) {
            throw new Error('Sale Return eligibility lineage is inconsistent.');
          }
          const returnedHistoricalValueMinor = cumulativeProportionalAmount(
            historicalNetValueMinor,
            returnedQuantityMilli,
            originalQuantityMilli,
          );
          const wasInventoryTracked = row.inventoryMovementId !== null;
          return {
            saleItemId: row.saleItemId,
            productId: row.productId,
            productUnitId: row.productUnitId,
            isManualLine: row.isManualLine,
            productNameSnapshot: row.productNameSnapshot,
            unitNameSnapshot: row.unitNameSnapshot,
            originalQuantityMilli,
            returnedQuantityMilli,
            remainingQuantityMilli: originalQuantityMilli - returnedQuantityMilli,
            historicalNetValueMinor,
            returnedHistoricalValueMinor,
            remainingHistoricalValueMinor: historicalNetValueMinor - returnedHistoricalValueMinor,
            wasInventoryTracked,
            currentRestockSaleableAllowed:
              !wasInventoryTracked ||
              (row.productStatus === 'active' &&
                row.productTracksInventory === true &&
                row.productUnitStatus === 'active'),
          };
        }),
      };
    });
  }

  private async resolvePosition(
    transaction: DatabaseTransaction,
    storeId: string,
    criteria: SaleReturnListCriteria,
  ): Promise<SaleReturnReadPosition> {
    const saleScope = criteria.saleId ? sql`and sale_id=${criteria.saleId}::uuid` : sql``;
    const result = await transaction.execute<PositionPhysicalRow>(sql`
      select id,return_at as "returnAt"
      from ledger.sale_returns
      where store_id=${storeId}::uuid and id=${criteria.anchor?.id}::uuid
        and version=${criteria.anchor?.version}::bigint and status <> 'draft' ${saleScope}
      limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new SaleReturnReadQueryError('cursor', 'saleReturnCursorAnchor');
    return { id: row.id, returnAt: new Date(row.returnAt) };
  }

  private mapSummary(row: SummaryPhysicalRow): SaleReturnSummaryRow {
    if (row.accountingPeriodId === null || row.lineCount <= 0) {
      throw new Error('Operational Sale Return root is incomplete.');
    }
    if (row.saleCustomerId !== row.customerId) {
      throw new Error('Sale Return Customer lineage is inconsistent.');
    }
    const customer = this.mapCustomer(row);
    const postingSnapshot = parseStoredSaleReturnPostingResponse(row.postingResponse);
    const totalMinor = BigInt(row.totalMinor);
    const version = BigInt(row.version);
    const settlementSummary = {
      receivableReductionMinor: BigInt(row.receivableReductionMinor),
      originalCustomerCreditRestorationMinor: BigInt(row.originalCreditRestorationMinor),
      newCustomerCreditMinor: BigInt(row.newCustomerCreditMinor),
      refundMinor: BigInt(row.refundMinor),
    };
    const settlementTotal = Object.values(settlementSummary).reduce(
      (sum, amount) => sum + amount,
      0n,
    );
    if (
      BigInt(row.lineTotalMinor) !== totalMinor ||
      BigInt(row.settlementTotalMinor) !== totalMinor ||
      settlementTotal !== totalMinor ||
      postingSnapshot.operationId !== row.operationId ||
      postingSnapshot.return.id !== row.id ||
      postingSnapshot.return.saleId !== row.saleId ||
      postingSnapshot.return.saleDisplayNumber !== row.saleDisplayNumber ||
      postingSnapshot.return.customerId !== row.customerId ||
      postingSnapshot.return.displayNumber !== row.displayNumber ||
      postingSnapshot.return.totalMinor !== row.totalMinor ||
      postingSnapshot.return.returnAt !== new Date(row.returnAt).toISOString() ||
      postingSnapshot.posting.accountingPeriodId !== row.accountingPeriodId ||
      postingSnapshot.settlementSummary.receivableReductionMinor !==
        settlementSummary.receivableReductionMinor.toString() ||
      postingSnapshot.settlementSummary.originalCustomerCreditRestorationMinor !==
        settlementSummary.originalCustomerCreditRestorationMinor.toString() ||
      postingSnapshot.settlementSummary.newCustomerCreditMinor !==
        settlementSummary.newCustomerCreditMinor.toString() ||
      postingSnapshot.settlementSummary.refundMinor !== settlementSummary.refundMinor.toString() ||
      (row.status === 'posted' && postingSnapshot.return.version !== version.toString())
    ) {
      throw new Error('Persisted Sale Return historical summary does not reconcile.');
    }
    return {
      id: row.id,
      saleId: row.saleId,
      saleDisplayNumber: row.saleDisplayNumber,
      saleAt: new Date(row.saleAt),
      saleStatus: row.saleStatus,
      saleCorrectionOfId: row.saleCorrectionOfId,
      saleReversedById: row.saleReversedById,
      customer,
      accountingPeriodId: row.accountingPeriodId,
      displayNumber: row.displayNumber,
      returnAt: new Date(row.returnAt),
      totalMinor,
      status: row.status,
      reason: row.reason,
      cancelledAt: row.cancelledAt === null ? null : new Date(row.cancelledAt),
      operationId: row.operationId,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      version,
      postingSnapshot,
      settlementSummary,
      dispositionSummary: {
        restockSaleableLineCount: row.restockSaleableLineCount,
        damagedNoRestockLineCount: row.damagedNoRestockLineCount,
        noInventoryEffectLineCount: row.noInventoryEffectLineCount,
      },
    };
  }

  private mapCustomer(row: SummaryPhysicalRow): SaleReturnReadCustomerRow | null {
    if (row.customerId === null) {
      if (
        row.customerName !== null ||
        row.customerPhone !== null ||
        row.customerStatus !== null ||
        row.customerArchivedAt !== null
      ) {
        throw new Error('Anonymous Sale Return has unexpected Customer data.');
      }
      return null;
    }
    if (row.customerName === null || row.customerPhone === null || row.customerStatus === null) {
      throw new Error('Registered Sale Return has incomplete Customer data.');
    }
    return {
      id: row.customerId,
      name: row.customerName,
      phone: row.customerPhone,
      status: row.customerStatus,
      archivedAt: row.customerArchivedAt === null ? null : new Date(row.customerArchivedAt),
    };
  }

  private mapEligibilityCustomer(row: EligibilityPhysicalRow): SaleReturnReadCustomerRow | null {
    if (row.customerId === null) return null;
    if (row.customerName === null || row.customerPhone === null || row.customerStatus === null) {
      throw new Error('Sale eligibility Customer data is incomplete.');
    }
    return {
      id: row.customerId,
      name: row.customerName,
      phone: row.customerPhone,
      status: row.customerStatus,
      archivedAt: row.customerArchivedAt === null ? null : new Date(row.customerArchivedAt),
    };
  }

  private mapLine(row: LinePhysicalRow, root: SaleReturnSummaryRow): SaleReturnLineReadRow {
    const snapshot = root.postingSnapshot.lines.find((line) => line.id === row.id);
    const disposition =
      row.itemCondition === 'saleable' ? 'RESTOCK_SALEABLE' : 'DAMAGED_NO_RESTOCK';
    if (
      !snapshot ||
      row.saleReturnId !== root.id ||
      row.saleId !== root.saleId ||
      snapshot.saleItemId !== row.saleItemId ||
      snapshot.productId !== row.productId ||
      snapshot.productUnitId !== row.productUnitId ||
      snapshot.quantityMilli !== row.quantityMilli ||
      snapshot.baseQuantityMilli !== row.baseQuantityMilli ||
      snapshot.lineRefundMinor !== row.lineRefundMinor ||
      snapshot.disposition !== disposition ||
      snapshot.itemCondition !== row.itemCondition
    ) {
      throw new Error('Persisted Sale Return line does not match its historical snapshot.');
    }

    const inventoryEffect = this.mapInventoryEffect(row, root, snapshot.inventoryMovement);
    return {
      id: row.id,
      saleItemId: row.saleItemId,
      productId: row.productId,
      productUnitId: row.productUnitId,
      isManualLine: row.isManualLine,
      productNameSnapshot: row.productNameSnapshot,
      unitNameSnapshot: row.unitNameSnapshot,
      productStatus: row.productStatus,
      productUnitStatus: row.productUnitStatus,
      quantityMilli: BigInt(row.quantityMilli),
      baseQuantityMilli: row.baseQuantityMilli === null ? null : BigInt(row.baseQuantityMilli),
      lineRefundMinor: BigInt(row.lineRefundMinor),
      disposition,
      costStatus: snapshot.costStatus,
      historicalCostMinor:
        snapshot.historicalCostMinor === null ? null : BigInt(snapshot.historicalCostMinor),
      cogsReversalMinor:
        snapshot.cogsReversalMinor === null ? null : BigInt(snapshot.cogsReversalMinor),
      inventoryEffect,
    };
  }

  private mapInventoryEffect(
    row: LinePhysicalRow,
    root: SaleReturnSummaryRow,
    snapshot: SaleReturnPostingResponse['lines'][number]['inventoryMovement'],
  ): SaleReturnInventoryEffectRow | null {
    if (row.inventoryMovementId === null) {
      if (snapshot !== null) {
        throw new Error('Sale Return inventory snapshot has no persisted movement.');
      }
      return null;
    }
    if (
      snapshot === null ||
      row.inventoryOperationId === null ||
      row.inventoryProductId === null ||
      row.inventoryProductUnitId === null ||
      row.inventoryMovementType !== 'customer_return_saleable' ||
      row.inventoryQuantityDeltaMilli === null ||
      row.inventoryValueDeltaMinor === null ||
      row.inventoryCostStatus === null ||
      row.inventoryReferenceType !== 'sale_return' ||
      row.inventoryReferenceId !== root.id ||
      row.inventoryTransactionGroupId !== root.postingSnapshot.transactionGroupId ||
      row.inventoryOccurredAt === null ||
      row.inventoryBusinessDate === null ||
      row.inventoryPostingDate === null ||
      snapshot.id !== row.inventoryMovementId ||
      snapshot.operationId !== row.inventoryOperationId ||
      snapshot.quantityDeltaMilli !== row.inventoryQuantityDeltaMilli ||
      snapshot.valueDeltaMinor !==
        (row.inventoryCostStatus === 'known' ? row.inventoryValueDeltaMinor : null)
    ) {
      throw new Error('Persisted Sale Return inventory effect does not reconcile.');
    }
    return {
      id: row.inventoryMovementId,
      operationId: row.inventoryOperationId,
      productId: row.inventoryProductId,
      productUnitId: row.inventoryProductUnitId,
      movementType: row.inventoryMovementType,
      quantityDeltaMilli: BigInt(row.inventoryQuantityDeltaMilli),
      valueDeltaMinor: BigInt(row.inventoryValueDeltaMinor),
      costStatus: row.inventoryCostStatus,
      referenceType: 'sale_return',
      referenceId: row.inventoryReferenceId,
      transactionGroupId: row.inventoryTransactionGroupId,
      occurredAt: new Date(row.inventoryOccurredAt),
      businessDate: row.inventoryBusinessDate,
      postingDate: row.inventoryPostingDate,
    };
  }

  private mapSettlement(
    row: SettlementPhysicalRow,
    root: SaleReturnSummaryRow,
  ): SaleReturnSettlementReadRow {
    const amountMinor = BigInt(row.amountMinor);
    const snapshot = root.postingSnapshot.settlements.find(
      (settlement) => settlement.id === row.id,
    );
    let kind: SaleReturnSettlementKind;
    let customerLedgerEffect: SaleReturnCustomerLedgerEffectRow | null = null;
    let moneyAccount: SaleReturnMoneyAccountRow | null = null;
    let moneyRefundEffect: SaleReturnMoneyRefundEffectRow | null = null;

    if (row.settlementType === 'money_refund') {
      kind = 'money_refund';
      moneyAccount = this.mapMoneyAccount(row);
      moneyRefundEffect = this.mapMoneyRefund(row, root, amountMinor);
    } else {
      customerLedgerEffect = this.mapCustomerLedgerEffect(row, root, amountMinor);
      kind =
        row.settlementType === 'reduce_receivable'
          ? 'receivable_reduction'
          : customerLedgerEffect.referenceType === 'sale_return_original_credit_restoration'
            ? 'original_customer_credit_restoration'
            : 'new_customer_credit';
    }
    if (
      !snapshot ||
      row.saleReturnId !== root.id ||
      snapshot.kind !== kind ||
      snapshot.amountMinor !== row.amountMinor ||
      (snapshot.customerLedgerEntryId !== customerLedgerEffect?.id &&
        !(snapshot.customerLedgerEntryId === null && customerLedgerEffect === null)) ||
      (snapshot.customerLedgerOperationId !== customerLedgerEffect?.operationId &&
        !(snapshot.customerLedgerOperationId === null && customerLedgerEffect === null)) ||
      (snapshot.moneyAccountId !== moneyAccount?.id &&
        !(snapshot.moneyAccountId === null && moneyAccount === null)) ||
      snapshot.moneyMovement?.id !== moneyRefundEffect?.id
    ) {
      throw new Error('Persisted Sale Return settlement does not match its historical snapshot.');
    }
    return { id: row.id, kind, amountMinor, customerLedgerEffect, moneyAccount, moneyRefundEffect };
  }

  private mapCustomerLedgerEffect(
    row: SettlementPhysicalRow,
    root: SaleReturnSummaryRow,
    amountMinor: bigint,
  ): SaleReturnCustomerLedgerEffectRow {
    if (
      row.customerLedgerEntryId === null ||
      row.customerLedgerOperationId === null ||
      row.customerLedgerEntryType === null ||
      row.customerLedgerReceivableDeltaMinor === null ||
      row.customerLedgerCreditDeltaMinor === null ||
      row.customerLedgerSourceSaleId !== root.saleId ||
      (row.customerLedgerReferenceType !== 'sale_return' &&
        row.customerLedgerReferenceType !== 'sale_return_original_credit_restoration') ||
      row.customerLedgerReferenceId !== root.id ||
      row.customerLedgerTransactionGroupId !== root.postingSnapshot.transactionGroupId ||
      row.customerLedgerOccurredAt === null
    ) {
      throw new Error('Sale Return Customer ledger lineage is incomplete.');
    }
    const receivableDeltaMinor = BigInt(row.customerLedgerReceivableDeltaMinor);
    const creditDeltaMinor = BigInt(row.customerLedgerCreditDeltaMinor);
    if (
      (row.settlementType === 'reduce_receivable' &&
        (row.customerLedgerEntryType !== 'return' ||
          receivableDeltaMinor !== -amountMinor ||
          creditDeltaMinor !== 0n ||
          row.customerLedgerReferenceType !== 'sale_return')) ||
      (row.settlementType === 'customer_credit' &&
        (row.customerLedgerEntryType !== 'credit_created' ||
          receivableDeltaMinor !== 0n ||
          creditDeltaMinor !== amountMinor))
    ) {
      throw new Error('Sale Return Customer ledger amount does not reconcile.');
    }
    return {
      id: row.customerLedgerEntryId,
      operationId: row.customerLedgerOperationId,
      entryType: row.customerLedgerEntryType,
      receivableDeltaMinor,
      creditDeltaMinor,
      sourceSaleId: row.customerLedgerSourceSaleId,
      referenceType: row.customerLedgerReferenceType,
      referenceId: row.customerLedgerReferenceId,
      transactionGroupId: row.customerLedgerTransactionGroupId,
      occurredAt: new Date(row.customerLedgerOccurredAt),
    };
  }

  private mapMoneyAccount(row: SettlementPhysicalRow): SaleReturnMoneyAccountRow {
    if (
      row.moneyAccountId === null ||
      row.moneyAccountName === null ||
      row.moneyAccountType === null ||
      row.moneyAccountStatus === null
    ) {
      throw new Error('Sale Return refund Money Account lineage is incomplete.');
    }
    return {
      id: row.moneyAccountId,
      name: row.moneyAccountName,
      accountType: row.moneyAccountType,
      status: row.moneyAccountStatus,
    };
  }

  private mapMoneyRefund(
    row: SettlementPhysicalRow,
    root: SaleReturnSummaryRow,
    amountMinor: bigint,
  ): SaleReturnMoneyRefundEffectRow {
    if (
      row.moneyMovementId === null ||
      row.moneyMovementOperationId === null ||
      row.moneyMovementAmountDeltaMinor === null ||
      row.moneyMovementType !== 'customer_refund' ||
      row.moneyMovementReferenceType !== 'sale_return' ||
      row.moneyMovementReferenceId !== root.id ||
      row.moneyMovementTransactionGroupId !== root.postingSnapshot.transactionGroupId ||
      row.moneyMovementOccurredAt === null ||
      BigInt(row.moneyMovementAmountDeltaMinor) !== -amountMinor
    ) {
      throw new Error('Sale Return Money refund lineage does not reconcile.');
    }
    return {
      id: row.moneyMovementId,
      operationId: row.moneyMovementOperationId,
      amountDeltaMinor: BigInt(row.moneyMovementAmountDeltaMinor),
      movementType: 'customer_refund',
      referenceType: 'sale_return',
      referenceId: row.moneyMovementReferenceId,
      transactionGroupId: row.moneyMovementTransactionGroupId,
      occurredAt: new Date(row.moneyMovementOccurredAt),
    };
  }

  private assertDetailIntegrity(
    root: SaleReturnSummaryRow,
    lines: SaleReturnLineReadRow[],
    settlements: SaleReturnSettlementReadRow[],
  ): void {
    if (
      lines.length !== root.postingSnapshot.lines.length ||
      settlements.length !== root.postingSnapshot.settlements.length ||
      lines.reduce((sum, line) => sum + line.lineRefundMinor, 0n) !== root.totalMinor ||
      settlements.reduce((sum, settlement) => sum + settlement.amountMinor, 0n) !==
        root.totalMinor ||
      new Set(lines.map((line) => line.id)).size !== lines.length ||
      new Set(settlements.map((settlement) => settlement.kind)).size !== settlements.length
    ) {
      throw new Error('Sale Return detail historical facts do not reconcile.');
    }
  }
}
