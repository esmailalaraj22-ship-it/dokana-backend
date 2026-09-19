import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { customers, sales } from '../database/schema';
import type { DatabaseTransaction } from '../database/database.types';
import type { CustomerReceivableSettlementPlanItem } from './customer-payment-allocation';
import type {
  CustomerCollectionAllocationCommand,
  CustomerCollectionAllocationMode,
  CustomerReceivableTargetType,
} from './customer-payment-posting-command';

export type CustomerReceivablePlanningFailureCode =
  | 'CUSTOMER_COLLECTION_ALLOCATION_EXCEEDS_OUTSTANDING'
  | 'CUSTOMER_COLLECTION_EXCEEDS_OUTSTANDING'
  | 'CUSTOMER_COLLECTION_TARGET_CUSTOMER_MISMATCH'
  | 'CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT'
  | 'CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE'
  | 'CUSTOMER_COLLECTION_TARGET_NOT_FOUND'
  | 'CUSTOMER_NOT_FOUND'
  | 'CUSTOMER_UNAVAILABLE';

interface FifoTargetReference extends Record<string, unknown> {
  targetType: CustomerReceivableTargetType;
  targetId: string;
  originId: string;
  occurredAt: string;
}

interface SaleOriginRow extends Record<string, unknown> {
  id: string;
  customerId: string;
  receivableDeltaMinor: string;
  creditDeltaMinor: string;
  sourceSaleId: string | null;
  referenceType: string;
  referenceId: string;
  occurredAt: string;
  reversalOfId: string | null;
  reversalCount: string;
  outstandingMinor: string;
}

interface LockedReceivableTarget extends CustomerReceivableSettlementPlanItem {
  customerId: string;
  occurredAt: Date;
  originalAmountMinor: bigint;
  outstandingMinor: bigint;
}

export interface CustomerReceivablePlanResult {
  plan: CustomerReceivableSettlementPlanItem[];
  unappliedMinor: bigint;
}

export class CustomerReceivablePlanningError extends Error {
  constructor(readonly code: CustomerReceivablePlanningFailureCode) {
    super(code);
    this.name = 'CustomerReceivablePlanningError';
  }
}

function reject(code: CustomerReceivablePlanningFailureCode): never {
  throw new CustomerReceivablePlanningError(code);
}

@Injectable()
export class CustomerReceivableSettlementRepository {
  async lockActiveCustomer(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
  ): Promise<void> {
    const rows = await transaction
      .select({ status: customers.status })
      .from(customers)
      .where(and(eq(customers.storeId, storeId), eq(customers.id, customerId)))
      .limit(1)
      .for('update');
    const customer = rows[0];
    if (!customer) reject('CUSTOMER_NOT_FOUND');
    if (customer.status !== 'active') reject('CUSTOMER_UNAVAILABLE');
  }

  async readAvailableCredit(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
  ): Promise<bigint> {
    const result = await transaction.execute<{ creditMinor: string }>(sql`
      select coalesce(sum(credit_delta_minor),0)::text as "creditMinor"
      from ledger.customer_ledger_entries
      where store_id=${storeId}::uuid and customer_id=${customerId}::uuid
    `);
    const creditMinor = BigInt(result.rows[0]?.creditMinor ?? '0');
    if (creditMinor < 0n) reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    return creditMinor;
  }

  async buildPlan(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
    allocationMode: CustomerCollectionAllocationMode,
    amountMinor: bigint,
    allocations: CustomerCollectionAllocationCommand[],
    allowPartial: boolean,
  ): Promise<CustomerReceivablePlanResult> {
    if (allocationMode === 'custom') {
      return {
        plan: await this.buildCustomPlan(transaction, storeId, customerId, allocations),
        unappliedMinor: 0n,
      };
    }

    const references = await this.listFifoTargetReferences(transaction, storeId, customerId);
    const plan: CustomerReceivableSettlementPlanItem[] = [];
    let remaining = amountMinor;
    for (const reference of references) {
      if (remaining === 0n) break;
      const target = await this.lockAndReadTarget(
        transaction,
        storeId,
        reference.targetType,
        reference.targetId,
      );
      this.assertTargetCustomer(target, customerId);
      if (
        target.originId !== reference.originId ||
        target.occurredAt.getTime() !== new Date(reference.occurredAt).getTime()
      ) {
        reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
      }
      if (target.outstandingMinor <= 0n) continue;
      const applied = target.outstandingMinor < remaining ? target.outstandingMinor : remaining;
      plan.push({
        targetType: target.targetType,
        targetId: target.targetId,
        originId: target.originId,
        amountMinor: applied,
      });
      remaining -= applied;
    }
    if (!allowPartial && remaining !== 0n) reject('CUSTOMER_COLLECTION_EXCEEDS_OUTSTANDING');
    return { plan, unappliedMinor: remaining };
  }

  private async buildCustomPlan(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
    allocations: CustomerCollectionAllocationCommand[],
  ): Promise<CustomerReceivableSettlementPlanItem[]> {
    const plan: CustomerReceivableSettlementPlanItem[] = [];
    for (const allocation of allocations) {
      const target = await this.lockAndReadTarget(
        transaction,
        storeId,
        allocation.targetType,
        allocation.targetId,
      );
      this.assertTargetCustomer(target, customerId);
      if (target.outstandingMinor <= 0n) reject('CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE');
      if (allocation.amountMinor > target.outstandingMinor) {
        reject('CUSTOMER_COLLECTION_ALLOCATION_EXCEEDS_OUTSTANDING');
      }
      plan.push({
        targetType: target.targetType,
        targetId: target.targetId,
        originId: target.originId,
        amountMinor: allocation.amountMinor,
      });
    }
    return plan;
  }

  private async listFifoTargetReferences(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
  ): Promise<FifoTargetReference[]> {
    const result = await transaction.execute<FifoTargetReference>(sql`
      select candidate."targetType", candidate."targetId", candidate."originId",
        candidate."occurredAt"
      from (
        select 'sale_receivable'::text as "targetType", sale.id as "targetId",
          origin.id as "originId", origin.occurred_at as "occurredAt",
          coalesce((select sum(effect.receivable_delta_minor)
            from ledger.customer_ledger_entries effect
            where effect.store_id=sale.store_id and effect.source_sale_id=sale.id),0)
            as outstanding
        from ledger.sales sale
        inner join ledger.customer_ledger_entries origin
          on origin.store_id=sale.store_id and origin.customer_id=sale.customer_id
          and origin.source_sale_id=sale.id and origin.entry_type='sale_credit'
          and origin.receivable_delta_minor > 0 and origin.credit_delta_minor=0
          and origin.reference_type='sale' and origin.reference_id=sale.id
          and origin.reversal_of_id is null
        where sale.store_id=${storeId}::uuid and sale.customer_id=${customerId}::uuid
          and sale.status='posted'
          and not exists (select 1 from ledger.customer_ledger_entries reversal
            where reversal.store_id=origin.store_id and reversal.reversal_of_id=origin.id)
        union all
        select 'opening_receivable'::text, origin.id, origin.id, origin.occurred_at,
          origin.receivable_delta_minor
          - coalesce((select sum(allocation.amount_minor)
            from ledger.customer_payment_allocations allocation
            inner join ledger.customer_payments payment
              on payment.store_id=allocation.store_id
              and payment.id=allocation.customer_payment_id
            where allocation.store_id=origin.store_id
              and allocation.opening_receivable_ledger_entry_id=origin.id
              and payment.status='posted'),0)
          + coalesce((select sum(effect.receivable_delta_minor)
            from ledger.customer_ledger_entries effect
            where effect.store_id=origin.store_id and effect.customer_id=origin.customer_id
              and effect.entry_type in ('credit_used','settlement')
              and effect.reference_type='customer_opening_receivable'
              and effect.reference_id=origin.id),0)
        from ledger.customer_ledger_entries origin
        where origin.store_id=${storeId}::uuid and origin.customer_id=${customerId}::uuid
          and origin.entry_type='opening_balance' and origin.receivable_delta_minor > 0
          and origin.credit_delta_minor=0 and origin.source_sale_id is null
          and origin.reference_type='customer_opening_receivable'
          and origin.reference_id=origin.id and origin.reversal_of_id is null
          and not exists (select 1 from ledger.customer_ledger_entries reversal
            where reversal.store_id=origin.store_id and reversal.reversal_of_id=origin.id)
      ) candidate
      where candidate.outstanding > 0
      order by candidate."occurredAt" asc, candidate."originId" asc
    `);
    return result.rows;
  }

  private lockAndReadTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    targetType: CustomerReceivableTargetType,
    targetId: string,
  ): Promise<LockedReceivableTarget> {
    return targetType === 'sale_receivable'
      ? this.lockAndReadSaleTarget(transaction, storeId, targetId)
      : this.lockAndReadOpeningTarget(transaction, storeId, targetId);
  }

  private async lockAndReadSaleTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    saleId: string,
  ): Promise<LockedReceivableTarget> {
    const saleRows = await transaction
      .select({ customerId: sales.customerId, status: sales.status })
      .from(sales)
      .where(and(eq(sales.storeId, storeId), eq(sales.id, saleId)))
      .limit(1)
      .for('update');
    const sale = saleRows[0];
    if (!sale) reject('CUSTOMER_COLLECTION_TARGET_NOT_FOUND');
    if (sale.customerId === null) reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    if (sale.status !== 'posted') reject('CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE');

    const result = await transaction.execute<SaleOriginRow>(sql`
      select origin.id, origin.customer_id as "customerId",
        origin.receivable_delta_minor::text as "receivableDeltaMinor",
        origin.credit_delta_minor::text as "creditDeltaMinor",
        origin.source_sale_id as "sourceSaleId", origin.reference_type as "referenceType",
        origin.reference_id as "referenceId", origin.occurred_at as "occurredAt",
        origin.reversal_of_id as "reversalOfId",
        (select count(*)::text from ledger.customer_ledger_entries reversal
          where reversal.store_id=origin.store_id and reversal.reversal_of_id=origin.id)
          as "reversalCount",
        coalesce((select sum(effect.receivable_delta_minor)
          from ledger.customer_ledger_entries effect
          where effect.store_id=origin.store_id and effect.source_sale_id=${saleId}::uuid),0)::text
          as "outstandingMinor"
      from ledger.customer_ledger_entries origin
      where origin.store_id=${storeId}::uuid and origin.source_sale_id=${saleId}::uuid
        and origin.entry_type='sale_credit'
      order by origin.id
      for update of origin
    `);
    if (result.rows.length !== 1) reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    const origin = result.rows[0];
    if (!origin) reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    if (
      origin.customerId !== sale.customerId ||
      BigInt(origin.receivableDeltaMinor) <= 0n ||
      origin.creditDeltaMinor !== '0' ||
      origin.sourceSaleId !== saleId ||
      origin.referenceType !== 'sale' ||
      origin.referenceId !== saleId ||
      origin.reversalOfId !== null
    ) {
      reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    }
    if (origin.reversalCount !== '0') reject('CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE');
    return this.targetFromOrigin('sale_receivable', saleId, origin);
  }

  private async lockAndReadOpeningTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    originId: string,
  ): Promise<LockedReceivableTarget> {
    const result = await transaction.execute<SaleOriginRow>(sql`
      select origin.id, origin.customer_id as "customerId",
        origin.receivable_delta_minor::text as "receivableDeltaMinor",
        origin.credit_delta_minor::text as "creditDeltaMinor",
        origin.source_sale_id as "sourceSaleId", origin.reference_type as "referenceType",
        origin.reference_id as "referenceId", origin.occurred_at as "occurredAt",
        origin.reversal_of_id as "reversalOfId",
        (select count(*)::text from ledger.customer_ledger_entries reversal
          where reversal.store_id=origin.store_id and reversal.reversal_of_id=origin.id)
          as "reversalCount",
        (origin.receivable_delta_minor
          - coalesce((select sum(allocation.amount_minor)
            from ledger.customer_payment_allocations allocation
            inner join ledger.customer_payments payment
              on payment.store_id=allocation.store_id and payment.id=allocation.customer_payment_id
            where allocation.store_id=origin.store_id
              and allocation.opening_receivable_ledger_entry_id=origin.id
              and payment.status='posted'),0)
          + coalesce((select sum(effect.receivable_delta_minor)
            from ledger.customer_ledger_entries effect
            where effect.store_id=origin.store_id and effect.customer_id=origin.customer_id
              and effect.entry_type in ('credit_used','settlement')
              and effect.reference_type='customer_opening_receivable'
              and effect.reference_id=origin.id),0))::text as "outstandingMinor"
      from ledger.customer_ledger_entries origin
      where origin.store_id=${storeId}::uuid and origin.id=${originId}::uuid
      for update of origin
    `);
    const origin = result.rows[0];
    if (!origin) reject('CUSTOMER_COLLECTION_TARGET_NOT_FOUND');
    if (
      BigInt(origin.receivableDeltaMinor) <= 0n ||
      origin.creditDeltaMinor !== '0' ||
      origin.sourceSaleId !== null ||
      origin.referenceType !== 'customer_opening_receivable' ||
      origin.referenceId !== origin.id ||
      origin.reversalOfId !== null
    ) {
      reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    }
    if (origin.reversalCount !== '0') reject('CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE');
    return this.targetFromOrigin('opening_receivable', origin.id, origin);
  }

  private targetFromOrigin(
    targetType: CustomerReceivableTargetType,
    targetId: string,
    origin: SaleOriginRow,
  ): LockedReceivableTarget {
    const originalAmountMinor = BigInt(origin.receivableDeltaMinor);
    const outstandingMinor = BigInt(origin.outstandingMinor);
    if (outstandingMinor < 0n || outstandingMinor > originalAmountMinor) {
      reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return {
      targetType,
      targetId,
      originId: origin.id,
      customerId: origin.customerId,
      occurredAt: new Date(origin.occurredAt),
      originalAmountMinor,
      outstandingMinor,
      amountMinor: 0n,
    };
  }

  private assertTargetCustomer(target: LockedReceivableTarget, customerId: string): void {
    if (target.customerId !== customerId) {
      reject('CUSTOMER_COLLECTION_TARGET_CUSTOMER_MISMATCH');
    }
  }
}
