import { BadRequestException, Injectable } from '@nestjs/common';

import { AccountingCorrectionWriteService } from '../accounting-corrections/accounting-correction-write.service';
import type { AccountingCorrectionDomain } from '../accounting-corrections/accounting-correction.types';
import type { SyncAuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { CustomerWriteService } from '../customers/customer-write.service';
import { ExpenseCorrectionService } from '../expenses/expense-correction.service';
import { ExpensePaymentService } from '../expenses/expense-payment.service';
import { ExpenseRecognitionService } from '../expenses/expense-recognition.service';
import { InventoryCorrectionService } from '../inventory/inventory-correction.service';
import { InventoryPostingService } from '../inventory/inventory-posting.service';
import { StockCountService } from '../inventory/stock-count.service';
import { MoneyTransferWriteService } from '../money-transfers/money-transfer-write.service';
import { OwnerLedgerWriteService } from '../owner-ledger/owner-ledger-write.service';
import { ProductWriteService } from '../products/product-write.service';
import { SaleReturnCorrectionService } from '../returns/sale-return-correction.service';
import { SaleReturnPostingService } from '../returns/sale-return-posting.service';
import { CustomerCreditService } from '../sales/customer-credit.service';
import type { CustomerFinancialCorrectionFamily } from '../sales/customer-financial-correction-command';
import { CustomerFinancialCorrectionService } from '../sales/customer-financial-correction.service';
import { CustomerPaymentPostingService } from '../sales/customer-payment-posting.service';
import { SaleCorrectionService } from '../sales/sale-correction.service';
import { SalePostingService } from '../sales/sale-posting.service';
import { SupplierInvoiceCorrectionService } from '../suppliers/supplier-invoice-correction.service';
import { SupplierInvoicePostingService } from '../suppliers/supplier-invoice-posting.service';
import { SupplierPaymentCorrectionService } from '../suppliers/supplier-payment-correction.service';
import { SupplierPaymentPostingService } from '../suppliers/supplier-payment-posting.service';
import { SupplierReturnService } from '../suppliers/supplier-return.service';
import { SupplierWriteService } from '../suppliers/supplier-write.service';
import type { OfflineOperationEnvelopeV1 } from './offline-operation.contract';
import type { SyncJsonObject } from './offline-operation-canonical-json';

export const OFFLINE_OPERATION_TYPES = [
  'customers.create.v1',
  'customers.update.v1',
  'suppliers.create.v1',
  'suppliers.update.v1',
  'products.create.v1',
  'products.update.v1',
  'product_units.create.v1',
  'product_units.update.v1',
  'owner_contributions.post.v1',
  'owner_loans.post.v1',
  'owner_reimbursements.post.v1',
  'owner_personal_withdrawals.post.v1',
  'owner_capital_withdrawals.post.v1',
  'owner_events.reverse.v1',
  'owner_events.replace.v1',
  'money_transfers.post.v1',
  'money_transfers.reverse.v1',
  'money_transfers.replace.v1',
  'inventory.opening.post.v1',
  'inventory.increase.post.v1',
  'inventory.decrease.post.v1',
  'inventory.corrections.post.v1',
  'stock_counts.post.v1',
  'supplier_invoices.post.v1',
  'supplier_invoices.cancel.v1',
  'supplier_invoices.edit.v1',
  'supplier_payments.post.v1',
  'supplier_payments.cancel.v1',
  'supplier_payments.edit.v1',
  'supplier_returns.post.v1',
  'supplier_credits.apply.v1',
  'supplier_refunds.post.v1',
  'supplier_returns.cancel.v1',
  'supplier_returns.replace.v1',
  'supplier_credits.cancel.v1',
  'supplier_credits.replace.v1',
  'supplier_refunds.cancel.v1',
  'supplier_refunds.replace.v1',
  'sales.post.v1',
  'sales.cancel.v1',
  'sales.edit.v1',
  'customer_collections.post.v1',
  'customer_collections.cancel.v1',
  'customer_collections.edit.v1',
  'customer_credits.apply.v1',
  'customer_credits.apply_cancel.v1',
  'customer_credits.apply_edit.v1',
  'customer_credits.refund.v1',
  'customer_credits.refund_cancel.v1',
  'customer_credits.refund_edit.v1',
  'customer_settlements.post.v1',
  'customer_settlements.cancel.v1',
  'customer_settlements.edit.v1',
  'expenses.post.v1',
  'expense_payments.post.v1',
  'expenses.cancel.v1',
  'expenses.edit.v1',
  'expense_payments.cancel.v1',
  'expense_payments.edit.v1',
  'sale_returns.post.v1',
  'sale_returns.cancel.v1',
  'sale_returns.replace.v1',
] as const;

export type OfflineOperationType = (typeof OFFLINE_OPERATION_TYPES)[number];
const operationTypeSet = new Set<string>(OFFLINE_OPERATION_TYPES);

interface RoutedValues {
  targetOperationId: string;
  domain: string;
  supplierId: string;
  customerId: string;
  expenseId: string;
  saleId: string;
  targetReturnId: string;
}

@Injectable()
export class OfflineOperationRegistry {
  constructor(
    private readonly customers: CustomerWriteService,
    private readonly suppliers: SupplierWriteService,
    private readonly products: ProductWriteService,
    private readonly ownerLedger: OwnerLedgerWriteService,
    private readonly accountingCorrections: AccountingCorrectionWriteService,
    private readonly moneyTransfers: MoneyTransferWriteService,
    private readonly inventory: InventoryPostingService,
    private readonly inventoryCorrections: InventoryCorrectionService,
    private readonly stockCounts: StockCountService,
    private readonly supplierInvoices: SupplierInvoicePostingService,
    private readonly supplierInvoiceCorrections: SupplierInvoiceCorrectionService,
    private readonly supplierPayments: SupplierPaymentPostingService,
    private readonly supplierPaymentCorrections: SupplierPaymentCorrectionService,
    private readonly supplierReturns: SupplierReturnService,
    private readonly sales: SalePostingService,
    private readonly saleCorrections: SaleCorrectionService,
    private readonly customerPayments: CustomerPaymentPostingService,
    private readonly customerCredits: CustomerCreditService,
    private readonly customerCorrections: CustomerFinancialCorrectionService,
    private readonly expenses: ExpenseRecognitionService,
    private readonly expensePayments: ExpensePaymentService,
    private readonly expenseCorrections: ExpenseCorrectionService,
    private readonly saleReturns: SaleReturnPostingService,
    private readonly saleReturnCorrections: SaleReturnCorrectionService,
  ) {}

  supports(operationType: string): operationType is OfflineOperationType {
    return operationTypeSet.has(operationType);
  }

  async dispatch(
    envelope: OfflineOperationEnvelopeV1,
    principal: SyncAuthenticatedPrincipal,
    context: TenantTransactionContext,
  ): Promise<SyncJsonObject> {
    if (!this.supports(envelope.operationType)) throw this.invalid('SYNC_OPERATION_NOT_ALLOWED');
    const body = this.commandBody(envelope);
    let response: unknown;

    switch (envelope.operationType) {
      case 'customers.create.v1':
        response = await this.customers.create(context, this.rootCreateBody(envelope));
        break;
      case 'customers.update.v1':
        response = await this.customers.update(
          context,
          this.aggregateId(envelope),
          this.updateBody(envelope),
        );
        break;
      case 'suppliers.create.v1':
        response = await this.suppliers.create(principal, context, this.rootCreateBody(envelope));
        break;
      case 'suppliers.update.v1':
        response = await this.suppliers.update(
          principal,
          context,
          this.aggregateId(envelope),
          this.updateBody(envelope),
        );
        break;
      case 'products.create.v1':
        response = await this.products.create(principal, context, this.rootCreateBody(envelope));
        break;
      case 'products.update.v1':
        response = await this.products.update(
          principal,
          context,
          this.aggregateId(envelope),
          this.updateBody(envelope),
        );
        break;
      case 'product_units.create.v1':
        response = await this.products.createUnit(
          principal,
          context,
          this.rootCreateBody(envelope),
        );
        break;
      case 'product_units.update.v1':
        response = await this.products.updateUnit(
          principal,
          context,
          this.aggregateId(envelope),
          this.updateBody(envelope),
        );
        break;
      case 'owner_contributions.post.v1':
        response = await this.ownerLedger.postContribution(principal, context, body as never);
        break;
      case 'owner_loans.post.v1':
        response = await this.ownerLedger.postLoan(principal, context, body as never);
        break;
      case 'owner_reimbursements.post.v1':
        response = await this.ownerLedger.postReimbursement(principal, context, body as never);
        break;
      case 'owner_personal_withdrawals.post.v1':
        response = await this.ownerLedger.postPersonalWithdrawal(principal, context, body as never);
        break;
      case 'owner_capital_withdrawals.post.v1':
        response = await this.ownerLedger.postCapitalWithdrawal(principal, context, body as never);
        break;
      case 'owner_events.reverse.v1': {
        const routed = this.route(body, ['targetOperationId', 'domain']);
        response = await this.accountingCorrections.reverse(
          principal,
          context,
          routed.values.targetOperationId,
          this.ownerDomain(routed.values.domain),
          routed.body,
        );
        break;
      }
      case 'owner_events.replace.v1': {
        const routed = this.route(body, ['targetOperationId', 'domain']);
        response = await this.accountingCorrections.replaceOwnerEvent(
          principal,
          context,
          routed.values.targetOperationId,
          this.ownerDomain(routed.values.domain),
          routed.body,
        );
        break;
      }
      case 'money_transfers.post.v1':
        response = await this.moneyTransfers.create(principal, context, body as never);
        break;
      case 'money_transfers.reverse.v1': {
        const routed = this.route(body, ['targetOperationId']);
        response = await this.accountingCorrections.reverse(
          principal,
          context,
          routed.values.targetOperationId,
          'internal_transfer',
          routed.body,
        );
        break;
      }
      case 'money_transfers.replace.v1': {
        const routed = this.route(body, ['targetOperationId']);
        response = await this.accountingCorrections.replaceTransfer(
          principal,
          context,
          routed.values.targetOperationId,
          routed.body,
        );
        break;
      }
      case 'inventory.opening.post.v1':
      case 'inventory.increase.post.v1':
      case 'inventory.decrease.post.v1': {
        const kind = envelope.operationType.split('.')[1] as 'opening' | 'increase' | 'decrease';
        response = await this.inventory.post(principal, context, kind, {
          ...body,
          entryId: this.aggregateId(envelope),
        });
        break;
      }
      case 'inventory.corrections.post.v1':
        response = await this.inventoryCorrections.correct(principal, context, body);
        break;
      case 'stock_counts.post.v1':
        response = await this.stockCounts.post(principal, context, {
          ...body,
          stockCountId: this.aggregateId(envelope),
        });
        break;
      case 'supplier_invoices.post.v1': {
        const routed = this.route(body, ['supplierId']);
        response = await this.supplierInvoices.postInvoice(
          principal,
          context,
          routed.values.supplierId,
          routed.body,
        );
        break;
      }
      case 'supplier_invoices.cancel.v1':
      case 'supplier_invoices.edit.v1': {
        const routed = this.route(body, ['targetOperationId']);
        response = envelope.operationType.endsWith('cancel.v1')
          ? await this.supplierInvoiceCorrections.cancelInvoice(
              principal,
              context,
              routed.values.targetOperationId,
              routed.body,
            )
          : await this.supplierInvoiceCorrections.editInvoice(
              principal,
              context,
              routed.values.targetOperationId,
              routed.body,
            );
        break;
      }
      case 'supplier_payments.post.v1': {
        const routed = this.route(body, ['supplierId']);
        response = await this.supplierPayments.post(
          principal,
          context,
          routed.values.supplierId,
          routed.body,
        );
        break;
      }
      case 'supplier_payments.cancel.v1':
      case 'supplier_payments.edit.v1': {
        const routed = this.route(body, ['targetOperationId']);
        response = envelope.operationType.endsWith('cancel.v1')
          ? await this.supplierPaymentCorrections.cancel(
              principal,
              context,
              routed.values.targetOperationId,
              routed.body,
            )
          : await this.supplierPaymentCorrections.edit(
              principal,
              context,
              routed.values.targetOperationId,
              routed.body,
            );
        break;
      }
      case 'supplier_returns.post.v1':
      case 'supplier_credits.apply.v1':
      case 'supplier_refunds.post.v1': {
        const routed = this.route(body, ['supplierId']);
        response = envelope.operationType.startsWith('supplier_returns')
          ? await this.supplierReturns.postReturn(
              principal,
              context,
              routed.values.supplierId,
              routed.body,
            )
          : envelope.operationType.startsWith('supplier_credits')
            ? await this.supplierReturns.applyCredit(
                principal,
                context,
                routed.values.supplierId,
                routed.body,
              )
            : await this.supplierReturns.recordRefund(
                principal,
                context,
                routed.values.supplierId,
                routed.body,
              );
        break;
      }
      case 'supplier_returns.cancel.v1':
      case 'supplier_returns.replace.v1':
      case 'supplier_credits.cancel.v1':
      case 'supplier_credits.replace.v1':
      case 'supplier_refunds.cancel.v1':
      case 'supplier_refunds.replace.v1': {
        const routed = this.route(body, ['targetOperationId']);
        const family = envelope.operationType.startsWith('supplier_returns')
          ? 'supplier_return'
          : envelope.operationType.startsWith('supplier_credits')
            ? 'supplier_credit_application'
            : 'supplier_refund';
        const kind = envelope.operationType.includes('.cancel.') ? 'cancel' : 'replace';
        response = await this.supplierReturns.correct(
          principal,
          context,
          family,
          kind,
          routed.values.targetOperationId,
          routed.body,
        );
        break;
      }
      case 'sales.post.v1':
        response = await this.sales.postSale(principal, context, body);
        break;
      case 'sales.cancel.v1':
      case 'sales.edit.v1': {
        const routed = this.route(body, ['targetOperationId']);
        response =
          envelope.operationType === 'sales.cancel.v1'
            ? await this.saleCorrections.cancel(
                principal,
                context,
                routed.values.targetOperationId,
                routed.body,
              )
            : await this.saleCorrections.edit(
                principal,
                context,
                routed.values.targetOperationId,
                routed.body,
              );
        break;
      }
      case 'customer_collections.post.v1': {
        const routed = this.route(body, ['customerId']);
        response = await this.customerPayments.post(
          principal,
          context,
          routed.values.customerId,
          routed.body,
        );
        break;
      }
      case 'customer_credits.apply.v1':
      case 'customer_credits.refund.v1':
      case 'customer_settlements.post.v1': {
        const routed = this.route(body, ['customerId']);
        response =
          envelope.operationType === 'customer_credits.apply.v1'
            ? await this.customerCredits.apply(
                principal,
                context,
                routed.values.customerId,
                routed.body,
              )
            : envelope.operationType === 'customer_credits.refund.v1'
              ? await this.customerCredits.refund(
                  principal,
                  context,
                  routed.values.customerId,
                  routed.body,
                )
              : await this.customerCredits.settle(
                  principal,
                  context,
                  routed.values.customerId,
                  routed.body,
                );
        break;
      }
      case 'customer_collections.cancel.v1':
      case 'customer_collections.edit.v1':
      case 'customer_credits.apply_cancel.v1':
      case 'customer_credits.apply_edit.v1':
      case 'customer_credits.refund_cancel.v1':
      case 'customer_credits.refund_edit.v1':
      case 'customer_settlements.cancel.v1':
      case 'customer_settlements.edit.v1': {
        const routed = this.route(body, ['customerId', 'targetOperationId']);
        const family = this.customerCorrectionFamily(envelope.operationType);
        const edit =
          envelope.operationType.endsWith('_edit.v1') ||
          envelope.operationType.endsWith('.edit.v1');
        response = edit
          ? await this.customerCorrections.edit(
              family,
              principal,
              context,
              routed.values.customerId,
              routed.values.targetOperationId,
              routed.body,
            )
          : await this.customerCorrections.cancel(
              family,
              principal,
              context,
              routed.values.customerId,
              routed.values.targetOperationId,
              routed.body,
            );
        break;
      }
      case 'expenses.post.v1':
        response = await this.expenses.recognize(principal, context, {
          ...body,
          id: this.aggregateId(envelope),
        });
        break;
      case 'expense_payments.post.v1': {
        const routed = this.route(body, ['expenseId']);
        response = await this.expensePayments.post(
          principal,
          context,
          routed.values.expenseId,
          routed.body,
        );
        break;
      }
      case 'expenses.cancel.v1':
      case 'expenses.edit.v1':
      case 'expense_payments.cancel.v1':
      case 'expense_payments.edit.v1': {
        const routed = this.route(body, ['targetOperationId']);
        if (envelope.operationType === 'expenses.cancel.v1')
          response = await this.expenseCorrections.cancelExpense(
            principal,
            context,
            routed.values.targetOperationId,
            routed.body,
          );
        else if (envelope.operationType === 'expenses.edit.v1')
          response = await this.expenseCorrections.editExpense(
            principal,
            context,
            routed.values.targetOperationId,
            routed.body,
          );
        else if (envelope.operationType === 'expense_payments.cancel.v1')
          response = await this.expenseCorrections.cancelPayment(
            principal,
            context,
            routed.values.targetOperationId,
            routed.body,
          );
        else
          response = await this.expenseCorrections.editPayment(
            principal,
            context,
            routed.values.targetOperationId,
            routed.body,
          );
        break;
      }
      case 'sale_returns.post.v1': {
        const routed = this.route(body, ['saleId']);
        response = await this.saleReturns.post(
          principal,
          context,
          routed.values.saleId,
          routed.body,
        );
        break;
      }
      case 'sale_returns.cancel.v1':
      case 'sale_returns.replace.v1': {
        const routed = this.route(body, ['targetReturnId']);
        response =
          envelope.operationType === 'sale_returns.cancel.v1'
            ? await this.saleReturnCorrections.cancel(
                principal,
                context,
                routed.values.targetReturnId,
                routed.body,
              )
            : await this.saleReturnCorrections.replace(
                principal,
                context,
                routed.values.targetReturnId,
                routed.body,
              );
        break;
      }
    }

    return this.jsonResponse(response);
  }

  private commandBody(envelope: OfflineOperationEnvelopeV1): Record<string, unknown> {
    if (Object.hasOwn(envelope.payload, 'operationId')) throw this.invalid('SYNC_PAYLOAD_INVALID');
    return { ...envelope.payload, operationId: envelope.operationId };
  }

  private rootCreateBody(envelope: OfflineOperationEnvelopeV1): never {
    const body = this.commandBody(envelope);
    if (Object.hasOwn(body, 'id')) throw this.invalid('SYNC_PAYLOAD_INVALID');
    return { ...body, id: this.aggregateId(envelope) } as never;
  }

  private updateBody(envelope: OfflineOperationEnvelopeV1): never {
    const body = this.commandBody(envelope);
    if (Object.hasOwn(body, 'expectedVersion') || envelope.expectedVersion === undefined) {
      throw this.invalid('SYNC_EXPECTED_VERSION_REQUIRED');
    }
    return { ...body, expectedVersion: envelope.expectedVersion } as never;
  }

  private aggregateId(envelope: OfflineOperationEnvelopeV1): string {
    if (!envelope.aggregateId) throw this.invalid('SYNC_AGGREGATE_ID_REQUIRED');
    return envelope.aggregateId;
  }

  private route(
    body: Record<string, unknown>,
    keys: readonly string[],
  ): { body: never; values: RoutedValues } {
    const routedKeys = new Set(keys);
    const copy = Object.fromEntries(Object.entries(body).filter(([key]) => !routedKeys.has(key)));
    const values: Record<string, string> = {};
    for (const key of keys) {
      const value = body[key];
      if (typeof value !== 'string') throw this.invalid('SYNC_PAYLOAD_INVALID');
      values[key] = value;
    }
    return { body: copy as never, values: values as unknown as RoutedValues };
  }

  private ownerDomain(
    value: string,
  ): Exclude<AccountingCorrectionDomain, 'opening_balance' | 'internal_transfer'> {
    if (
      ![
        'owner_contribution',
        'owner_loan',
        'owner_reimbursement',
        'owner_personal_withdrawal',
        'owner_capital_withdrawal',
      ].includes(value)
    ) {
      throw this.invalid('SYNC_PAYLOAD_INVALID');
    }
    return value as Exclude<AccountingCorrectionDomain, 'opening_balance' | 'internal_transfer'>;
  }

  private customerCorrectionFamily(
    operationType: OfflineOperationType,
  ): CustomerFinancialCorrectionFamily {
    if (operationType.startsWith('customer_collections')) return 'customer_collection';
    if (operationType.startsWith('customer_credits.apply')) return 'customer_credit_application';
    if (operationType.startsWith('customer_credits.refund')) return 'customer_credit_refund';
    return 'customer_receivable_settlement';
  }

  private jsonResponse(value: unknown): SyncJsonObject {
    const serialized = JSON.stringify(value);
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Domain operation returned a non-object response.');
    }
    return parsed as SyncJsonObject;
  }

  private invalid(code: string): BadRequestException {
    return new BadRequestException({ code, message: 'Offline operation is invalid.' });
  }
}
