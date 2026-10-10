import { randomUUID } from 'node:crypto';

import type { SyncAuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { OfflineOperationEnvelopeV1 } from './offline-operation.contract';
import {
  OFFLINE_OPERATION_TYPES,
  OfflineOperationRegistry,
  type OfflineOperationType,
} from './offline-operation.registry';

type ServiceMock = Record<string, jest.Mock<Promise<Record<string, unknown>>, unknown[]>>;

function serviceMethod(): jest.Mock<Promise<Record<string, unknown>>, unknown[]> {
  return jest.fn<Promise<Record<string, unknown>>, unknown[]>();
}

const services = {
  customers: { create: serviceMethod(), update: serviceMethod() },
  suppliers: { create: serviceMethod(), update: serviceMethod() },
  products: {
    create: serviceMethod(),
    update: serviceMethod(),
    createUnit: serviceMethod(),
    updateUnit: serviceMethod(),
  },
  ownerLedger: {
    postContribution: serviceMethod(),
    postLoan: serviceMethod(),
    postReimbursement: serviceMethod(),
    postPersonalWithdrawal: serviceMethod(),
    postCapitalWithdrawal: serviceMethod(),
  },
  accountingCorrections: {
    reverse: serviceMethod(),
    replaceOwnerEvent: serviceMethod(),
    replaceTransfer: serviceMethod(),
  },
  moneyTransfers: { create: serviceMethod() },
  inventory: { post: serviceMethod() },
  inventoryCorrections: { correct: serviceMethod() },
  stockCounts: { post: serviceMethod() },
  supplierInvoices: { postInvoice: serviceMethod() },
  supplierInvoiceCorrections: {
    cancelInvoice: serviceMethod(),
    editInvoice: serviceMethod(),
  },
  supplierPayments: { post: serviceMethod() },
  supplierPaymentCorrections: { cancel: serviceMethod(), edit: serviceMethod() },
  supplierReturns: {
    postReturn: serviceMethod(),
    applyCredit: serviceMethod(),
    recordRefund: serviceMethod(),
    correct: serviceMethod(),
  },
  sales: { postSale: serviceMethod() },
  saleCorrections: { cancel: serviceMethod(), edit: serviceMethod() },
  customerPayments: { post: serviceMethod() },
  customerCredits: {
    apply: serviceMethod(),
    refund: serviceMethod(),
    settle: serviceMethod(),
  },
  customerCorrections: { edit: serviceMethod(), cancel: serviceMethod() },
  expenses: { recognize: serviceMethod() },
  expensePayments: { post: serviceMethod() },
  expenseCorrections: {
    cancelExpense: serviceMethod(),
    editExpense: serviceMethod(),
    cancelPayment: serviceMethod(),
    editPayment: serviceMethod(),
  },
  saleReturns: { post: serviceMethod() },
  saleReturnCorrections: { cancel: serviceMethod(), replace: serviceMethod() },
} satisfies Record<string, ServiceMock>;

type ServiceName = keyof typeof services;

const expectedRoutes = {
  'customers.create.v1': ['customers', 'create'],
  'customers.update.v1': ['customers', 'update'],
  'suppliers.create.v1': ['suppliers', 'create'],
  'suppliers.update.v1': ['suppliers', 'update'],
  'products.create.v1': ['products', 'create'],
  'products.update.v1': ['products', 'update'],
  'product_units.create.v1': ['products', 'createUnit'],
  'product_units.update.v1': ['products', 'updateUnit'],
  'owner_contributions.post.v1': ['ownerLedger', 'postContribution'],
  'owner_loans.post.v1': ['ownerLedger', 'postLoan'],
  'owner_reimbursements.post.v1': ['ownerLedger', 'postReimbursement'],
  'owner_personal_withdrawals.post.v1': ['ownerLedger', 'postPersonalWithdrawal'],
  'owner_capital_withdrawals.post.v1': ['ownerLedger', 'postCapitalWithdrawal'],
  'owner_events.reverse.v1': ['accountingCorrections', 'reverse'],
  'owner_events.replace.v1': ['accountingCorrections', 'replaceOwnerEvent'],
  'money_transfers.post.v1': ['moneyTransfers', 'create'],
  'money_transfers.reverse.v1': ['accountingCorrections', 'reverse'],
  'money_transfers.replace.v1': ['accountingCorrections', 'replaceTransfer'],
  'inventory.opening.post.v1': ['inventory', 'post'],
  'inventory.increase.post.v1': ['inventory', 'post'],
  'inventory.decrease.post.v1': ['inventory', 'post'],
  'inventory.corrections.post.v1': ['inventoryCorrections', 'correct'],
  'stock_counts.post.v1': ['stockCounts', 'post'],
  'supplier_invoices.post.v1': ['supplierInvoices', 'postInvoice'],
  'supplier_invoices.cancel.v1': ['supplierInvoiceCorrections', 'cancelInvoice'],
  'supplier_invoices.edit.v1': ['supplierInvoiceCorrections', 'editInvoice'],
  'supplier_payments.post.v1': ['supplierPayments', 'post'],
  'supplier_payments.cancel.v1': ['supplierPaymentCorrections', 'cancel'],
  'supplier_payments.edit.v1': ['supplierPaymentCorrections', 'edit'],
  'supplier_returns.post.v1': ['supplierReturns', 'postReturn'],
  'supplier_credits.apply.v1': ['supplierReturns', 'applyCredit'],
  'supplier_refunds.post.v1': ['supplierReturns', 'recordRefund'],
  'supplier_returns.cancel.v1': ['supplierReturns', 'correct'],
  'supplier_returns.replace.v1': ['supplierReturns', 'correct'],
  'supplier_credits.cancel.v1': ['supplierReturns', 'correct'],
  'supplier_credits.replace.v1': ['supplierReturns', 'correct'],
  'supplier_refunds.cancel.v1': ['supplierReturns', 'correct'],
  'supplier_refunds.replace.v1': ['supplierReturns', 'correct'],
  'sales.post.v1': ['sales', 'postSale'],
  'sales.cancel.v1': ['saleCorrections', 'cancel'],
  'sales.edit.v1': ['saleCorrections', 'edit'],
  'customer_collections.post.v1': ['customerPayments', 'post'],
  'customer_collections.cancel.v1': ['customerCorrections', 'cancel'],
  'customer_collections.edit.v1': ['customerCorrections', 'edit'],
  'customer_credits.apply.v1': ['customerCredits', 'apply'],
  'customer_credits.apply_cancel.v1': ['customerCorrections', 'cancel'],
  'customer_credits.apply_edit.v1': ['customerCorrections', 'edit'],
  'customer_credits.refund.v1': ['customerCredits', 'refund'],
  'customer_credits.refund_cancel.v1': ['customerCorrections', 'cancel'],
  'customer_credits.refund_edit.v1': ['customerCorrections', 'edit'],
  'customer_settlements.post.v1': ['customerCredits', 'settle'],
  'customer_settlements.cancel.v1': ['customerCorrections', 'cancel'],
  'customer_settlements.edit.v1': ['customerCorrections', 'edit'],
  'expenses.post.v1': ['expenses', 'recognize'],
  'expense_payments.post.v1': ['expensePayments', 'post'],
  'expenses.cancel.v1': ['expenseCorrections', 'cancelExpense'],
  'expenses.edit.v1': ['expenseCorrections', 'editExpense'],
  'expense_payments.cancel.v1': ['expenseCorrections', 'cancelPayment'],
  'expense_payments.edit.v1': ['expenseCorrections', 'editPayment'],
  'sale_returns.post.v1': ['saleReturns', 'post'],
  'sale_returns.cancel.v1': ['saleReturnCorrections', 'cancel'],
  'sale_returns.replace.v1': ['saleReturnCorrections', 'replace'],
} satisfies Record<OfflineOperationType, readonly [ServiceName, string]>;

const context: TenantTransactionContext = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  requestId: randomUUID(),
};
const principal: SyncAuthenticatedPrincipal = {
  userId: context.userId,
  email: 'owner@example.test',
  fullName: 'Owner',
  storeId: context.storeId,
  storeName: 'Store',
  storeStatus: 'active',
  membershipRole: 'owner',
  membershipVersion: '1',
  deviceId: context.deviceId,
  sessionId: randomUUID(),
  sessionExpiresAt: new Date('2026-01-10T00:00:00.000Z'),
};

function envelope(operationType: OfflineOperationType): OfflineOperationEnvelopeV1 {
  const licenseId = randomUUID();
  const subscriptionId = randomUUID();
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    operationType,
    storeId: context.storeId,
    deviceId: context.deviceId,
    aggregateId: randomUUID(),
    expectedVersion: '1',
    clientRecordedAt: '2026-01-02T00:00:00.000Z',
    payload: {
      targetOperationId: randomUUID(),
      domain: 'owner_contribution',
      supplierId: randomUUID(),
      customerId: randomUUID(),
      expenseId: randomUUID(),
      saleId: randomUUID(),
      targetReturnId: randomUUID(),
    },
    offlineLicenseId: licenseId,
    signedLicense: {
      algorithm: 'Ed25519',
      payload: {
        licenseVersion: 1,
        licenseId,
        storeId: context.storeId,
        deviceId: context.deviceId,
        subscriptionId,
        subscriptionVersion: '1',
        issuedAt: '2026-01-01T00:00:00.000Z',
        offlineValidUntil: '2026-01-08T00:00:00.000Z',
        centralEntitlementEnd: '2026-12-01T00:00:00.000Z',
        storeEntitlement: {
          storeStatus: 'active',
          subscriptionStatus: 'active',
          effectiveAccess: 'write',
        },
        signingKeyId: 'license-v1',
      },
      signature: 'x'.repeat(86),
    },
    signingKeyId: 'license-v1',
    subscriptionId,
    subscriptionVersion: '1',
    trustedTimeEvidence: {
      version: 1,
      trustedServerTime: '2026-01-01T00:00:00.000Z',
      observedDeviceTime: '2026-01-02T00:00:00.000Z',
      clockState: 'trusted',
      knownStoreStatus: 'active',
      knownStoreStatusAt: '2026-01-01T00:00:00.000Z',
    },
    localSequence: '1',
    dependsOnOperationIds: [],
    provenanceHash: 'a'.repeat(64),
  };
}

describe('OfflineOperationRegistry', () => {
  const dependencies = Object.values(services) as unknown as ConstructorParameters<
    typeof OfflineOperationRegistry
  >;
  const registry = new OfflineOperationRegistry(...dependencies);

  beforeEach(() => {
    for (const service of Object.values(services)) {
      for (const method of Object.values(service)) {
        method.mockReset();
        method.mockResolvedValue({ accepted: true });
      }
    }
  });

  it('keeps the concrete allowlist and expected canonical service mapping exhaustive', async () => {
    expect(new Set(OFFLINE_OPERATION_TYPES).size).toBe(OFFLINE_OPERATION_TYPES.length);
    expect(Object.keys(expectedRoutes).sort()).toEqual([...OFFLINE_OPERATION_TYPES].sort());

    for (const operationType of OFFLINE_OPERATION_TYPES) {
      const [serviceName, methodName] = expectedRoutes[operationType];
      await expect(registry.dispatch(envelope(operationType), principal, context)).resolves.toEqual(
        {
          accepted: true,
        },
      );
      expect((services[serviceName] as ServiceMock)[methodName]).toHaveBeenCalledTimes(1);
      const calls = Object.values(services).flatMap((service) =>
        Object.values(service).map((method) => method.mock.calls.length),
      );
      expect(calls.reduce((sum, count) => sum + count, 0)).toBe(1);
      jest.clearAllMocks();
    }
  });

  it.each([
    'settings.update.v1',
    'customers.archive.v1',
    'accounting_periods.close.v1',
    'subscriptions.activate.v1',
  ])('does not expose online-only or unknown operation %s', (operationType) => {
    expect(registry.supports(operationType)).toBe(false);
  });

  it('rejects payload attempts to override operation identity', async () => {
    const value = envelope('customers.create.v1');
    value.payload = { operationId: randomUUID() };
    await expect(registry.dispatch(value, principal, context)).rejects.toMatchObject({
      response: { code: 'SYNC_PAYLOAD_INVALID' },
    });
    expect(services.customers.create).not.toHaveBeenCalled();
  });

  it('requires expectedVersion for mutable update commands', async () => {
    const value = envelope('products.update.v1');
    delete value.expectedVersion;
    await expect(registry.dispatch(value, principal, context)).rejects.toMatchObject({
      response: { code: 'SYNC_EXPECTED_VERSION_REQUIRED' },
    });
    expect(services.products.update).not.toHaveBeenCalled();
  });
});
