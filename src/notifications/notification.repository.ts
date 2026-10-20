import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import type {
  NotificationCause,
  NotificationListCriteria,
  NotificationListRow,
} from './notification.types';

interface SettingsPhysicalRow extends Record<string, unknown> {
  customerDebtAmountAlertMinor: string;
  debtAgeAlertDays: number;
  defaultCreditLimitMinor: string | null;
  lowStockAlertEnabled: boolean;
  timezoneName: string;
  businessDate: string;
}

interface CustomerAmountPhysicalRow extends Record<string, unknown> {
  id: string;
  name: string;
  netDueMinor: string;
  effectiveCreditLimitMinor: string | null;
}

interface CustomerAgePhysicalRow extends Record<string, unknown> {
  id: string;
  name: string;
  oldestOccurredAt: string;
  ageDays: number;
}

interface SupplierDuePhysicalRow extends Record<string, unknown> {
  id: string;
  displayNumber: string;
  supplierName: string;
  outstandingMinor: string;
  dueDate: string;
}

interface SupplierCreditPhysicalRow extends Record<string, unknown> {
  id: string;
  name: string;
  creditMinor: string;
}

interface StockPhysicalRow extends Record<string, unknown> {
  id: string;
  name: string;
  quantityMilli: string;
  lowStockThresholdMilli: string | null;
}

interface ExpenseDuePhysicalRow extends Record<string, unknown> {
  id: string;
  description: string;
  dueMinor: string;
  dueDate: string;
}

interface EntitlementPhysicalRow extends Record<string, unknown> {
  subscriptionId: string | null;
  entitlementEndsAt: string | null;
  warningActive: boolean;
}

interface ExistingNotificationRow extends Record<string, unknown> {
  id: string;
  notificationKey: string;
  type: NotificationListRow['type'];
  severity: NotificationListRow['severity'];
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
}

interface NotificationPhysicalRow extends Record<string, unknown> {
  id: string;
  type: NotificationListRow['type'];
  severity: NotificationListRow['severity'];
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  resolvedAt: string | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const managedKeyPrefix = 's21:v1:';

@Injectable()
export class NotificationRepository {
  constructor(private readonly database: DatabaseService) {}

  reconcile(
    context: TenantTransactionContext,
    externalCauses: readonly NotificationCause[] = [],
  ): Promise<void> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      await transaction.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${'dokana:s21:notifications:' + context.storeId}, 0)
        )
      `);

      const causes = await this.readCanonicalCauses(transaction, context.storeId);
      for (const cause of externalCauses) {
        if (
          !cause.key.startsWith(managedKeyPrefix) ||
          cause.entityId !== context.storeId ||
          causes.some((existing) => existing.key === cause.key)
        ) {
          throw new Error('External notification cause is not valid for this Store.');
        }
        causes.push(cause);
      }
      causes.sort((left, right) => left.key.localeCompare(right.key));
      const existingResult = await transaction.execute<ExistingNotificationRow>(sql`
        select
          id,
          notification_key as "notificationKey",
          notification_type as type,
          severity,
          title,
          body,
          entity_type as "entityType",
          entity_id as "entityId"
        from ledger.notifications
        where store_id=${context.storeId}::uuid
          and resolved_at is null
          and notification_key like ${managedKeyPrefix + '%'}
        order by notification_key
        for update
      `);
      const existingByKey = new Map(
        existingResult.rows.map((notification) => [notification.notificationKey, notification]),
      );

      for (const cause of causes) {
        const current = existingByKey.get(cause.key);
        if (current) {
          existingByKey.delete(cause.key);
          if (
            current.type !== cause.type ||
            current.severity !== cause.severity ||
            current.title !== cause.title ||
            current.body !== cause.body ||
            current.entityType !== cause.entityType ||
            current.entityId !== cause.entityId
          ) {
            await transaction.execute(sql`
              update ledger.notifications
              set notification_type=${cause.type}, severity=${cause.severity},
                  title=${cause.title}, body=${cause.body},
                  entity_type=${cause.entityType}, entity_id=${cause.entityId}::uuid
              where store_id=${context.storeId}::uuid and id=${current.id}::uuid
            `);
          }
          continue;
        }

        await transaction.execute(sql`
          insert into ledger.notifications (
            id, store_id, notification_key, notification_type, severity,
            title, body, entity_type, entity_id, status
          ) values (
            ${randomUUID()}::uuid, ${context.storeId}::uuid, ${cause.key},
            ${cause.type}, ${cause.severity}, ${cause.title}, ${cause.body},
            ${cause.entityType}, ${cause.entityId}::uuid, 'unread'
          )
        `);
      }

      for (const stale of existingByKey.values()) {
        await transaction.execute(sql`
          update ledger.notifications
          set notification_key=notification_key || ':resolved:' || id::text,
              status='resolved', resolved_at=clock_timestamp(), snoozed_until=null
          where store_id=${context.storeId}::uuid and id=${stale.id}::uuid
            and resolved_at is null
        `);
      }

      await transaction.execute(sql`
        delete from ledger.notifications
        where id in (
          select id
          from ledger.notifications
          where store_id=${context.storeId}::uuid
            and resolved_at < clock_timestamp() - interval '180 days'
          order by resolved_at, id
          limit 100
        )
      `);
    });
  }

  list(
    context: TenantTransactionContext,
    criteria: NotificationListCriteria,
  ): Promise<NotificationListRow[]> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const lifecycle =
        criteria.lifecycle === 'active'
          ? sql`and notification.resolved_at is null`
          : criteria.lifecycle === 'resolved'
            ? sql`and notification.resolved_at is not null`
            : sql``;
      const read =
        criteria.read === true
          ? sql`and presentation.read_at is not null`
          : criteria.read === false
            ? sql`and presentation.read_at is null`
            : sql``;
      const type = criteria.type ? sql`and notification.notification_type=${criteria.type}` : sql``;
      const cursor = criteria.anchor
        ? sql`and (
            notification.created_at < ${criteria.anchor.createdAt}
            or (
              notification.created_at = ${criteria.anchor.createdAt}
              and notification.id < ${criteria.anchor.id}::uuid
            )
          )`
        : sql``;
      const result = await transaction.execute<NotificationPhysicalRow>(sql`
        select
          notification.id,
          notification.notification_type as type,
          notification.severity,
          notification.title,
          notification.body,
          notification.entity_type as "entityType",
          notification.entity_id as "entityId",
          notification.resolved_at as "resolvedAt",
          presentation.read_at as "readAt",
          notification.created_at as "createdAt",
          notification.updated_at as "updatedAt"
        from ledger.notifications notification
        left join ledger.notification_user_states presentation
          on presentation.store_id=notification.store_id
         and presentation.notification_id=notification.id
         and presentation.user_id=${context.userId}::uuid
        where notification.store_id=${context.storeId}::uuid
          ${lifecycle}
          ${read}
          ${type}
          ${cursor}
        order by notification.created_at desc, notification.id desc
        limit ${criteria.limit + 1}
      `);
      return result.rows.map((row) => ({
        ...row,
        resolvedAt: row.resolvedAt === null ? null : new Date(row.resolvedAt),
        readAt: row.readAt === null ? null : new Date(row.readAt),
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      }));
    });
  }

  setReadState(
    context: TenantTransactionContext,
    notificationId: string,
    read: boolean,
  ): Promise<Date | null | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const exists = await transaction.execute(sql`
        select id
        from ledger.notifications
        where store_id=${context.storeId}::uuid and id=${notificationId}::uuid
        limit 1
      `);
      if (exists.rows.length === 0) return undefined;

      const result = await transaction.execute<
        { readAt: string | null } & Record<string, unknown>
      >(sql`
        insert into ledger.notification_user_states (
          store_id, notification_id, user_id, read_at
        ) values (
          ${context.storeId}::uuid, ${notificationId}::uuid,
          ${context.userId}::uuid,
          ${read ? sql`clock_timestamp()` : sql`null`}
        )
        on conflict (store_id, notification_id, user_id)
        do update set read_at=excluded.read_at
        returning read_at as "readAt"
      `);
      const readAt = result.rows[0]?.readAt;
      return readAt === null || readAt === undefined ? readAt : new Date(readAt);
    });
  }

  private async readCanonicalCauses(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<NotificationCause[]> {
    const settingsResult = await transaction.execute<SettingsPhysicalRow>(sql`
      select
        customer_debt_amount_alert_minor::text as "customerDebtAmountAlertMinor",
        debt_age_alert_days as "debtAgeAlertDays",
        default_credit_limit_minor::text as "defaultCreditLimitMinor",
        low_stock_alert_enabled as "lowStockAlertEnabled",
        timezone_name as "timezoneName",
        (clock_timestamp() at time zone timezone_name)::date::text as "businessDate"
      from ledger.app_settings
      where store_id=${storeId}::uuid
      limit 1
    `);
    const settings = settingsResult.rows[0];
    if (!settings) throw new Error('Notification reconciliation requires initialized settings.');

    const causes: NotificationCause[] = [];
    await this.addCustomerCauses(transaction, storeId, settings, causes);
    await this.addSupplierCauses(
      transaction,
      storeId,
      settings.businessDate,
      settings.timezoneName,
      causes,
    );
    await this.addInventoryCauses(transaction, storeId, settings.lowStockAlertEnabled, causes);
    await this.addExpenseCauses(
      transaction,
      storeId,
      settings.businessDate,
      settings.timezoneName,
      causes,
    );
    await this.addSubscriptionCause(transaction, storeId, causes);
    return causes.sort((left, right) => left.key.localeCompare(right.key));
  }

  private async addCustomerCauses(
    transaction: DatabaseTransaction,
    storeId: string,
    settings: SettingsPhysicalRow,
    causes: NotificationCause[],
  ): Promise<void> {
    const balances = await transaction.execute<CustomerAmountPhysicalRow>(sql`
      select
        customer.id,
        customer.name,
        balance.net_due_minor::text as "netDueMinor",
        coalesce(customer.credit_limit_minor, settings.default_credit_limit_minor)::text
          as "effectiveCreditLimitMinor"
      from ledger.customers customer
      join ledger.v_customer_balances balance
        on balance.store_id=customer.store_id and balance.customer_id=customer.id
      join ledger.app_settings settings on settings.store_id=customer.store_id
      where customer.store_id=${storeId}::uuid
        and balance.net_due_minor > 0
      order by customer.id
    `);
    const amountThreshold = BigInt(settings.customerDebtAmountAlertMinor);
    for (const customer of balances.rows) {
      const due = BigInt(customer.netDueMinor);
      if (due >= amountThreshold) {
        causes.push({
          key: this.key('customer_debt_amount', 'customer', customer.id),
          type: 'customer_debt_amount',
          severity: 'warning',
          title: 'Customer debt threshold reached',
          body: `${customer.name} owes ${due.toString()} minor units.`,
          entityType: 'customer',
          entityId: customer.id,
        });
      }
      if (
        customer.effectiveCreditLimitMinor !== null &&
        due >= BigInt(customer.effectiveCreditLimitMinor)
      ) {
        causes.push({
          key: this.key('customer_credit_limit', 'customer', customer.id),
          type: 'customer_credit_limit',
          severity: 'critical',
          title: 'Customer credit limit reached',
          body: `${customer.name} has reached the effective credit limit.`,
          entityType: 'customer',
          entityId: customer.id,
        });
      }
    }

    const aged = await transaction.execute<CustomerAgePhysicalRow>(sql`
      with origin_state as (
        select
          origin.customer_id,
          origin.occurred_at,
          case
            when origin.entry_type='sale_credit'
              then coalesce(invoice_outstanding.outstanding_minor, 0)
            else origin.receivable_delta_minor - origin.credit_delta_minor + coalesce((
              select sum(adjustment.receivable_delta_minor - adjustment.credit_delta_minor)
              from ledger.customer_ledger_entries adjustment
              where adjustment.store_id=origin.store_id
                and adjustment.reversal_of_id=origin.id
            ), 0) + coalesce((
              select sum(adjustment.receivable_delta_minor)
              from ledger.customer_ledger_entries adjustment
              where adjustment.store_id=origin.store_id
                and adjustment.customer_id=origin.customer_id
                and adjustment.entry_type in ('credit_used','settlement')
                and adjustment.reference_type='customer_opening_receivable'
                and adjustment.reference_id=origin.id
            ), 0) - coalesce((
              select sum(allocation.amount_minor)
              from ledger.customer_payment_allocations allocation
              join ledger.customer_payments payment
                on payment.store_id=allocation.store_id
               and payment.id=allocation.customer_payment_id
              where allocation.store_id=origin.store_id
                and allocation.opening_receivable_ledger_entry_id=origin.id
                and payment.status='posted'
            ), 0)
          end as outstanding_minor
        from ledger.customer_ledger_entries origin
        left join ledger.v_customer_invoice_outstanding invoice_outstanding
          on invoice_outstanding.store_id=origin.store_id
         and invoice_outstanding.sale_id=origin.source_sale_id
        where origin.store_id=${storeId}::uuid
          and origin.entry_type in ('sale_credit','opening_balance')
          and origin.reversal_of_id is null
          and origin.receivable_delta_minor - origin.credit_delta_minor > 0
      )
      select
        customer.id,
        customer.name,
        min(origin.occurred_at)::text as "oldestOccurredAt",
        (${settings.businessDate}::date -
          (min(origin.occurred_at) at time zone ${settings.timezoneName})::date)::int as "ageDays"
      from origin_state origin
      join ledger.customers customer
        on customer.store_id=${storeId}::uuid and customer.id=origin.customer_id
      where origin.outstanding_minor > 0
      group by customer.id, customer.name
      having (${settings.businessDate}::date -
        (min(origin.occurred_at) at time zone ${settings.timezoneName})::date) >=
        ${settings.debtAgeAlertDays}
      order by customer.id
    `);
    for (const customer of aged.rows) {
      causes.push({
        key: this.key('customer_debt_age', 'customer', customer.id),
        type: 'customer_debt_age',
        severity: 'warning',
        title: 'Customer debt is overdue',
        body: `${customer.name} has outstanding debt aged ${String(customer.ageDays)} completed days.`,
        entityType: 'customer',
        entityId: customer.id,
      });
    }
  }

  private async addSupplierCauses(
    transaction: DatabaseTransaction,
    storeId: string,
    businessDate: string,
    timezoneName: string,
    causes: NotificationCause[],
  ): Promise<void> {
    const due = await transaction.execute<SupplierDuePhysicalRow>(sql`
      with due_invoice as (
        select invoice.id, invoice.display_number, invoice.due_at,
               supplier.name as supplier_name,
               outstanding.outstanding_minor - coalesce((
                 select sum(allocation.amount_minor)
                 from ledger.supplier_payment_allocations allocation
                 join ledger.supplier_payments payment
                   on payment.store_id=allocation.store_id
                  and payment.id=allocation.supplier_payment_id
                 where allocation.store_id=invoice.store_id
                   and allocation.purchase_invoice_id=invoice.id
                   and payment.status='posted'
               ), 0) as outstanding_minor
        from ledger.purchase_invoices invoice
        join ledger.suppliers supplier
          on supplier.store_id=invoice.store_id and supplier.id=invoice.supplier_id
        join ledger.v_supplier_invoice_outstanding outstanding
          on outstanding.store_id=invoice.store_id
         and outstanding.purchase_invoice_id=invoice.id
        where invoice.store_id=${storeId}::uuid
          and invoice.status in ('open', 'closed')
          and invoice.due_at is not null
          and (invoice.due_at at time zone ${timezoneName})::date <= ${businessDate}::date
      )
      select id, display_number as "displayNumber", supplier_name as "supplierName",
             outstanding_minor::text as "outstandingMinor",
             (due_at at time zone ${timezoneName})::date::text as "dueDate"
      from due_invoice
      where outstanding_minor > 0
      order by id
    `);
    for (const invoice of due.rows) {
      causes.push({
        key: this.key('supplier_due', 'supplier_invoice', invoice.id),
        type: 'supplier_due',
        severity: 'warning',
        title: 'Supplier invoice is due',
        body: `${invoice.supplierName} invoice ${invoice.displayNumber} has ${invoice.outstandingMinor} minor units outstanding.`,
        entityType: 'supplier_invoice',
        entityId: invoice.id,
      });
    }

    const credits = await transaction.execute<SupplierCreditPhysicalRow>(sql`
      select supplier.id, supplier.name,
             abs(balance.net_payable_minor)::text as "creditMinor"
      from ledger.suppliers supplier
      join ledger.v_supplier_balances balance
        on balance.store_id=supplier.store_id and balance.supplier_id=supplier.id
      where supplier.store_id=${storeId}::uuid
        and balance.net_payable_minor < 0
      order by supplier.id
    `);
    for (const supplier of credits.rows) {
      causes.push({
        key: this.key('review_required', 'supplier', supplier.id),
        type: 'review_required',
        severity: 'info',
        title: 'Supplier credit requires review',
        body: `${supplier.name} has ${supplier.creditMinor} minor units of supplier credit.`,
        entityType: 'supplier',
        entityId: supplier.id,
      });
    }
  }

  private async addInventoryCauses(
    transaction: DatabaseTransaction,
    storeId: string,
    lowStockEnabled: boolean,
    causes: NotificationCause[],
  ): Promise<void> {
    const rows = await transaction.execute<StockPhysicalRow>(sql`
      select product.id, product.name,
             balance.quantity_milli::text as "quantityMilli",
             product.low_stock_threshold_milli::text as "lowStockThresholdMilli"
      from ledger.products product
      join ledger.stock_balances balance
        on balance.store_id=product.store_id and balance.product_id=product.id
      where product.store_id=${storeId}::uuid
        and product.status='active' and product.track_inventory
        and (
          balance.quantity_milli <= 0
          or (${lowStockEnabled} and product.low_stock_threshold_milli is not null
              and balance.quantity_milli <= product.low_stock_threshold_milli)
        )
      order by product.id
    `);
    for (const product of rows.rows) {
      const quantity = BigInt(product.quantityMilli);
      const negative = quantity < 0n;
      causes.push({
        key: this.key(negative ? 'negative_stock' : 'low_stock', 'product', product.id),
        type: negative ? 'negative_stock' : 'low_stock',
        severity: negative ? 'critical' : 'warning',
        title: negative
          ? 'Product stock is negative'
          : quantity === 0n
            ? 'Product is out of stock'
            : 'Product stock is low',
        body: `${product.name} has ${quantity.toString()} milli-units available.`,
        entityType: 'product',
        entityId: product.id,
      });
    }
  }

  private async addExpenseCauses(
    transaction: DatabaseTransaction,
    storeId: string,
    businessDate: string,
    timezoneName: string,
    causes: NotificationCause[],
  ): Promise<void> {
    const rows = await transaction.execute<ExpenseDuePhysicalRow>(sql`
      select expense.id, expense.description,
             balance.due_minor::text as "dueMinor",
             (expense.due_at at time zone ${timezoneName})::date::text as "dueDate"
      from ledger.expenses expense
      join ledger.v_expense_balances balance
        on balance.store_id=expense.store_id and balance.expense_id=expense.id
      where expense.store_id=${storeId}::uuid
        and expense.due_at is not null
        and (expense.due_at at time zone ${timezoneName})::date <= ${businessDate}::date
        and balance.due_minor > 0
      order by expense.id
    `);
    for (const expense of rows.rows) {
      causes.push({
        key: this.key('expense_due', 'expense', expense.id),
        type: 'expense_due',
        severity: 'warning',
        title: 'Expense payment is due',
        body: `${expense.description} has ${expense.dueMinor} minor units outstanding.`,
        entityType: 'expense',
        entityId: expense.id,
      });
    }
  }

  private async addSubscriptionCause(
    transaction: DatabaseTransaction,
    storeId: string,
    causes: NotificationCause[],
  ): Promise<void> {
    const result = await transaction.execute<EntitlementPhysicalRow>(sql`
      select subscription_id as "subscriptionId",
             entitlement_ends_at as "entitlementEndsAt",
             entitlement_ends_at <= checked_at + interval '7 days' as "warningActive"
      from ledger.lock_effective_entitlement(${storeId}::uuid)
    `);
    const entitlement = result.rows[0];
    if (entitlement?.subscriptionId && entitlement.entitlementEndsAt && entitlement.warningActive) {
      causes.push({
        key: this.key('subscription_expiry', 'subscription', entitlement.subscriptionId),
        type: 'subscription_expiry',
        severity: 'warning',
        title: 'Subscription expiry requires attention',
        body: `The current subscription entitlement ends at ${new Date(entitlement.entitlementEndsAt).toISOString()}.`,
        entityType: 'subscription',
        entityId: entitlement.subscriptionId,
      });
    }
  }

  private key(type: string, entityType: string, entityId: string): string {
    return `${managedKeyPrefix}${type}:${entityType}:${entityId}`;
  }
}
