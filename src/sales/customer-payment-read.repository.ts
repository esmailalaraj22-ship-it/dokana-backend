import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import type {
  MoneyAccountPhysicalType,
  MoneyAccountStatus,
} from '../money-accounts/money-account.types';
import { CustomerFinancialCorrectionReadRepository } from './customer-financial-correction-read.repository';
import type { ResolvedCustomerFinancialLineage } from './customer-financial-correction-read.types';
import type {
  CustomerPaymentAllocationRow,
  CustomerPaymentCustomerRow,
  CustomerPaymentDetailRow,
  CustomerPaymentListCriteria,
  CustomerPaymentListPosition,
  CustomerPaymentListRow,
} from './customer-payment-read.types';
import { SaleReadQueryError } from './sale-read-query-error';

interface CustomerPhysicalRow extends Record<string, unknown> {
  id: string;
  name: string;
  phone: string;
  status: 'active' | 'archived';
  archivedAt: string | null;
  outstandingMinor: string;
  creditBalanceMinor: string;
}

interface CustomerPaymentPhysicalRow extends Record<string, unknown> {
  id: string;
  customerId: string;
  accountingPeriodId: string | null;
  operationId: string;
  collectionId: string | null;
  amountMinor: string;
  allocatedTotalMinor: string;
  creditCreatedMinor: string;
  moneyAccountId: string;
  moneyAccountName: string | null;
  moneyAccountType: MoneyAccountPhysicalType | null;
  moneyAccountStatus: MoneyAccountStatus | null;
  paymentAt: string;
  senderAccountName: string | null;
  externalReference: string | null;
  notes: string | null;
  status: 'posted' | 'cancelled';
  moneyMovementId: string | null;
  cancelledAt: string | null;
  allocationCount: number;
  allocationTotalMinor: string;
  createdAt: string;
  updatedAt: string;
  version: string;
}

interface CustomerPaymentAnchorRow extends Record<string, unknown> {
  id: string;
  paymentAt: string;
}

interface CustomerPaymentAllocationPhysicalRow extends Record<string, unknown> {
  id: string;
  saleId: string | null;
  openingReceivableId: string | null;
  amountMinor: string;
  saleDisplayNumber: string | null;
  saleOccurredAt: string | null;
  openingAmountMinor: string | null;
  openingOccurredAt: string | null;
  customerLedgerEntryId: string | null;
  paymentEffectOperationId: string | null;
  paymentEffectReceivableDeltaMinor: string | null;
  paymentEffectCreditDeltaMinor: string | null;
  paymentEffectReferenceType: string | null;
  paymentEffectReferenceId: string | null;
  paymentEffectSourceSaleId: string | null;
  createdAt: string;
}

@Injectable()
export class CustomerPaymentReadRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly correctionReads: CustomerFinancialCorrectionReadRepository,
  ) {}

  readPage(
    context: TenantTransactionContext,
    customerId: string,
    criteria: CustomerPaymentListCriteria,
  ): Promise<
    { customer: CustomerPaymentCustomerRow; payments: CustomerPaymentListRow[] } | undefined
  > {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const customer = await this.readCustomer(transaction, context.storeId, customerId);
      if (!customer) return undefined;

      let position: CustomerPaymentListPosition | null = null;
      if (criteria.anchor) {
        const result = await transaction.execute<CustomerPaymentAnchorRow>(sql`
          select id, payment_at as "paymentAt"
          from ledger.customer_payments
          where store_id=${context.storeId}::uuid and customer_id=${customerId}::uuid
            and id=${criteria.anchor.id}::uuid and version=${criteria.anchor.version}::bigint
            and status in ('posted','cancelled')
          limit 1 for share
        `);
        const anchor = result.rows[0];
        if (!anchor) throw new SaleReadQueryError('cursor', 'customerPaymentCursorAnchor');
        position = { id: anchor.id, paymentAt: new Date(anchor.paymentAt) };
      }
      return {
        customer,
        payments: await this.readPayments(
          transaction,
          context.storeId,
          customerId,
          position,
          criteria.limit + 1,
        ),
      };
    });
  }

  findById(
    context: TenantTransactionContext,
    customerId: string,
    paymentId: string,
  ): Promise<CustomerPaymentDetailRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const customer = await this.readCustomer(transaction, context.storeId, customerId);
      if (!customer) return undefined;
      const paymentResult = await transaction.execute<CustomerPaymentPhysicalRow>(sql`
        ${this.paymentSelect()}
        where payment.store_id=${context.storeId}::uuid
          and payment.customer_id=${customerId}::uuid and payment.id=${paymentId}::uuid
          and payment.status in ('posted','cancelled')
        limit 1
      `);
      const payment = paymentResult.rows[0];
      if (!payment) return undefined;
      const lineage = await this.resolveLineage(
        transaction,
        context.storeId,
        customerId,
        payment.collectionId,
      );
      const allocationResult = await transaction.execute<CustomerPaymentAllocationPhysicalRow>(sql`
        select allocation.id, allocation.sale_id as "saleId",
          allocation.opening_receivable_ledger_entry_id as "openingReceivableId",
          allocation.amount_minor::text as "amountMinor",
          sale.display_number as "saleDisplayNumber", sale.sale_at as "saleOccurredAt",
          opening.receivable_delta_minor::text as "openingAmountMinor",
          opening.occurred_at as "openingOccurredAt",
          allocation.customer_ledger_entry_id as "customerLedgerEntryId",
          effect.operation_id as "paymentEffectOperationId",
          effect.receivable_delta_minor::text as "paymentEffectReceivableDeltaMinor",
          effect.credit_delta_minor::text as "paymentEffectCreditDeltaMinor",
          effect.reference_type as "paymentEffectReferenceType",
          effect.reference_id as "paymentEffectReferenceId",
          effect.source_sale_id as "paymentEffectSourceSaleId",
          allocation.created_at as "createdAt"
        from ledger.customer_payment_allocations allocation
        left join ledger.sales sale
          on sale.store_id=allocation.store_id and sale.id=allocation.sale_id
        left join ledger.customer_ledger_entries opening
          on opening.store_id=allocation.store_id
          and opening.id=allocation.opening_receivable_ledger_entry_id
        left join ledger.customer_ledger_entries effect
          on effect.store_id=allocation.store_id and effect.id=allocation.customer_ledger_entry_id
        where allocation.store_id=${context.storeId}::uuid
          and allocation.customer_payment_id=${paymentId}::uuid
        order by allocation.created_at asc, allocation.id asc
      `);
      return {
        ...this.mapPayment(payment, lineage),
        customer,
        allocations: allocationResult.rows.map((row) => this.mapAllocation(row, paymentId)),
        corrections: lineage.corrections,
      };
    });
  }

  private async readCustomer(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
  ): Promise<CustomerPaymentCustomerRow | undefined> {
    const result = await transaction.execute<CustomerPhysicalRow>(sql`
      select customer.id, customer.name, customer.phone, customer.status,
        customer.archived_at as "archivedAt",
        greatest(coalesce(balance.receivable_minor,0),0)::text as "outstandingMinor",
        greatest(coalesce(balance.credit_minor,0),0)::text as "creditBalanceMinor"
      from ledger.customers customer
      left join ledger.v_customer_balances balance
        on balance.store_id=customer.store_id and balance.customer_id=customer.id
      where customer.store_id=${storeId}::uuid and customer.id=${customerId}::uuid
      limit 1
    `);
    const row = result.rows[0];
    if (!row) return undefined;
    const outstandingMinor = BigInt(row.outstandingMinor);
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      status: row.status,
      archivedAt: row.archivedAt === null ? null : new Date(row.archivedAt),
      outstandingMinor,
      creditBalanceMinor: BigInt(row.creditBalanceMinor),
    };
  }

  private async readPayments(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
    position: CustomerPaymentListPosition | null,
    limit: number,
  ): Promise<CustomerPaymentListRow[]> {
    const continuation = position
      ? sql`and (payment.payment_at < ${position.paymentAt}
          or (payment.payment_at=${position.paymentAt} and payment.id < ${position.id}::uuid))`
      : sql``;
    const result = await transaction.execute<CustomerPaymentPhysicalRow>(sql`
      ${this.paymentSelect()}
      where payment.store_id=${storeId}::uuid and payment.customer_id=${customerId}::uuid
        and payment.status in ('posted','cancelled') ${continuation}
      order by payment.payment_at desc, payment.id desc
      limit ${limit}
    `);
    const lineages = await this.correctionReads.resolve(
      transaction,
      storeId,
      customerId,
      result.rows.map((row) => {
        if (row.collectionId === null) {
          throw new Error('Customer Payment transaction group is missing.');
        }
        return row.collectionId;
      }),
    );
    return result.rows.map((row) => {
      if (row.collectionId === null) {
        throw new Error('Customer Payment transaction group is missing.');
      }
      const lineage = lineages.get(row.collectionId);
      if (!lineage) throw new Error('Customer Payment correction lineage is missing.');
      return this.mapPayment(row, lineage);
    });
  }

  private paymentSelect(): ReturnType<typeof sql> {
    return sql`
      select payment.id, payment.customer_id as "customerId",
        payment.accounting_period_id as "accountingPeriodId",
        payment.operation_id as "operationId", movement.transaction_group_id as "collectionId",
        payment.amount_minor::text as "amountMinor",
        payment.allocated_total_minor::text as "allocatedTotalMinor",
        payment.credit_created_minor::text as "creditCreatedMinor",
        payment.money_account_id as "moneyAccountId", account.name as "moneyAccountName",
        account.account_type as "moneyAccountType", account.status as "moneyAccountStatus",
        payment.payment_at as "paymentAt", payment.sender_account_name as "senderAccountName",
        payment.external_reference as "externalReference", payment.notes, payment.status,
        payment.money_movement_id as "moneyMovementId", payment.cancelled_at as "cancelledAt",
        (select count(*)::integer from ledger.customer_payment_allocations allocation
          where allocation.store_id=payment.store_id
            and allocation.customer_payment_id=payment.id) as "allocationCount",
        coalesce((select sum(allocation.amount_minor)
          from ledger.customer_payment_allocations allocation
          where allocation.store_id=payment.store_id
            and allocation.customer_payment_id=payment.id),0)::text as "allocationTotalMinor",
        payment.created_at as "createdAt", payment.updated_at as "updatedAt",
        payment.version::text as version
      from ledger.customer_payments payment
      left join ledger.money_accounts account
        on account.store_id=payment.store_id and account.id=payment.money_account_id
      left join ledger.money_movements movement
        on movement.store_id=payment.store_id and movement.id=payment.money_movement_id
    `;
  }

  private mapPayment(
    row: CustomerPaymentPhysicalRow,
    lineage: ResolvedCustomerFinancialLineage,
  ): CustomerPaymentListRow {
    if (
      row.accountingPeriodId === null ||
      row.collectionId === null ||
      row.moneyMovementId === null ||
      row.moneyAccountName === null ||
      row.moneyAccountType === null ||
      row.moneyAccountStatus === null ||
      BigInt(row.allocationTotalMinor) !== BigInt(row.allocatedTotalMinor)
    ) {
      throw new Error('Customer Payment presentation is inconsistent.');
    }
    return {
      id: row.id,
      customerId: row.customerId,
      accountingPeriodId: row.accountingPeriodId,
      operationId: row.operationId,
      collectionId: row.collectionId,
      amountMinor: BigInt(row.amountMinor),
      allocatedTotalMinor: BigInt(row.allocatedTotalMinor),
      creditCreatedMinor: BigInt(row.creditCreatedMinor),
      moneyAccount: {
        id: row.moneyAccountId,
        name: row.moneyAccountName,
        accountType: row.moneyAccountType,
        status: row.moneyAccountStatus,
      },
      paymentAt: new Date(row.paymentAt),
      senderAccountName: row.senderAccountName,
      externalReference: row.externalReference,
      notes: row.notes,
      status: row.status,
      moneyMovementId: row.moneyMovementId,
      cancelledAt: row.cancelledAt === null ? null : new Date(row.cancelledAt),
      allocationCount: row.allocationCount,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      version: BigInt(row.version),
      lineage: lineage.lineage,
    };
  }

  private async resolveLineage(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
    collectionId: string | null,
  ): Promise<ResolvedCustomerFinancialLineage> {
    if (collectionId === null) throw new Error('Customer Payment transaction group is missing.');
    const lineage = (
      await this.correctionReads.resolve(transaction, storeId, customerId, [collectionId])
    ).get(collectionId);
    if (!lineage) throw new Error('Customer Payment correction lineage is missing.');
    return lineage;
  }

  private mapAllocation(
    row: CustomerPaymentAllocationPhysicalRow,
    paymentId: string,
  ): CustomerPaymentAllocationRow {
    if (
      row.customerLedgerEntryId === null ||
      row.paymentEffectOperationId === null ||
      row.paymentEffectReceivableDeltaMinor === null ||
      row.paymentEffectCreditDeltaMinor !== '0' ||
      row.paymentEffectReferenceType !== 'customer_payment' ||
      row.paymentEffectReferenceId !== paymentId ||
      BigInt(row.paymentEffectReceivableDeltaMinor) !== -BigInt(row.amountMinor)
    ) {
      throw new Error('Customer Payment allocation effect is inconsistent.');
    }
    if (
      row.saleId !== null &&
      row.openingReceivableId === null &&
      row.saleDisplayNumber !== null &&
      row.saleOccurredAt !== null &&
      row.openingAmountMinor === null &&
      row.openingOccurredAt === null &&
      row.paymentEffectSourceSaleId === row.saleId
    ) {
      return {
        id: row.id,
        targetType: 'sale_receivable',
        targetId: row.saleId,
        amountMinor: BigInt(row.amountMinor),
        saleDisplayNumber: row.saleDisplayNumber,
        openingAmountMinor: null,
        originOccurredAt: new Date(row.saleOccurredAt),
        customerLedgerEntryId: row.customerLedgerEntryId,
        paymentEffectOperationId: row.paymentEffectOperationId,
        paymentEffectReceivableDeltaMinor: BigInt(row.paymentEffectReceivableDeltaMinor),
        createdAt: new Date(row.createdAt),
      };
    }
    if (
      row.saleId === null &&
      row.openingReceivableId !== null &&
      row.saleDisplayNumber === null &&
      row.saleOccurredAt === null &&
      row.openingAmountMinor !== null &&
      row.openingOccurredAt !== null &&
      row.paymentEffectSourceSaleId === null
    ) {
      return {
        id: row.id,
        targetType: 'opening_receivable',
        targetId: row.openingReceivableId,
        amountMinor: BigInt(row.amountMinor),
        saleDisplayNumber: null,
        openingAmountMinor: BigInt(row.openingAmountMinor),
        originOccurredAt: new Date(row.openingOccurredAt),
        customerLedgerEntryId: row.customerLedgerEntryId,
        paymentEffectOperationId: row.paymentEffectOperationId,
        paymentEffectReceivableDeltaMinor: BigInt(row.paymentEffectReceivableDeltaMinor),
        createdAt: new Date(row.createdAt),
      };
    }
    throw new Error('Customer Payment allocation target is inconsistent.');
  }
}
