import type { ReferenceObject, SchemaObject, SchemasObject } from '@nestjs/swagger';

type Properties = NonNullable<SchemaObject['properties']>;

const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const nullableUuid: SchemaObject = { ...uuid, nullable: true };
const integerString: SchemaObject = { type: 'string', pattern: '^-?[0-9]+$' };
const moneyMinor: SchemaObject = {
  ...integerString,
  description:
    'Exact signed ILS amount in minor units (agorot). This decimal string is authoritative; never parse it as a JavaScript floating-point number.',
  example: '9007199254740993',
};
const nullableMoneyMinor: SchemaObject = { ...moneyMinor, nullable: true };
const quantityMilli: SchemaObject = {
  ...integerString,
  description:
    'Exact signed inventory quantity in integer milli-units (1000 = one base unit). Keep it as a decimal string.',
  example: '1250',
};
const nullableQuantityMilli: SchemaObject = { ...quantityMilli, nullable: true };
const version: SchemaObject = {
  type: 'string',
  pattern: '^[0-9]+$',
  description: 'Exact optimistic-concurrency version. Keep it as a decimal string.',
  example: '3',
};
const businessDate: SchemaObject = {
  type: 'string',
  format: 'date',
  description: 'Store-local business date in the Asia/Hebron timezone.',
};
const postingDate: SchemaObject = {
  type: 'string',
  format: 'date',
  description: 'Canonical financial posting date selected by server-side posting policy.',
};
const nullablePostingDate: SchemaObject = { ...postingDate, nullable: true };
const occurredAt: SchemaObject = {
  type: 'string',
  format: 'date-time',
  description: 'UTC event chronology timestamp; it does not redefine the Store business date.',
};
const nullableOccurredAt: SchemaObject = { ...occurredAt, nullable: true };
const asOf: SchemaObject = {
  type: 'string',
  format: 'date-time',
  description: 'UTC timestamp of the consistent read snapshot represented by this response.',
};
const nullableString: SchemaObject = { type: 'string', nullable: true };
const nonNegativeInteger: SchemaObject = { type: 'integer', minimum: 0 };
const timezone: SchemaObject = {
  type: 'string',
  enum: ['Asia/Hebron'],
  description: 'Store operational timezone used by current MVP read models.',
};

function reference(name: string): ReferenceObject {
  return { $ref: `#/components/schemas/${name}` };
}

function object(properties: Properties, required = Object.keys(properties)): SchemaObject {
  return { type: 'object', additionalProperties: false, properties, required };
}

function array(items: SchemaObject | ReferenceObject): SchemaObject {
  return { type: 'array', items };
}

function stringEnum(values: readonly string[], description?: string): SchemaObject {
  return { type: 'string', enum: [...values], ...(description ? { description } : {}) };
}

function scalarProperties(names: readonly string[], schema: SchemaObject): Properties {
  return Object.fromEntries(names.map((name) => [name, schema]));
}

function reportFilters(properties: Properties, optional: readonly string[] = []): SchemaObject {
  const optionalNames = new Set(optional);
  return object(
    properties,
    Object.keys(properties).filter((name) => !optionalNames.has(name)),
  );
}

function pagedReport(
  row: string,
  totals: string,
  filters: SchemaObject,
  dateAuthorities: readonly string[],
  extra: Properties = {},
): SchemaObject {
  return object({
    asOf,
    timezoneName: timezone,
    dateAuthority: stringEnum(
      dateAuthorities,
      'Field used to interpret the report date scope. currentState reports are snapshots rather than event-date histories.',
    ),
    filters,
    items: array(reference(row)),
    totals: object({ page: reference(totals), filtered: reference(totals) }),
    pagination: object({
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      nextCursor: {
        type: 'string',
        nullable: true,
        maxLength: 192,
        description:
          'Opaque, Store- and filter-scope-bound keyset cursor. Reuse unchanged with the same filters; null means the page is final.',
      },
    }),
    ...extra,
  });
}

const reportDateFilters = reportFilters(
  {
    fromDate: businessDate,
    toDate: businessDate,
    accountingPeriodId: nullableUuid,
  },
  ['accountingPeriodId'],
);

const operationalMoneyFields = [
  'salesMinor',
  'immediateSaleCollectionsMinor',
  'customerCollectionsMinor',
  'customerReceivableAllocationsMinor',
  'creditSalesMinor',
  'expensesRecognizedMinor',
  'expensePaymentsMinor',
  'supplierInvoicesMinor',
  'supplierPaymentsMinor',
  'saleReturnsMinor',
  'supplierReturnsMinor',
] as const;

export const S20_SCHEMA_NAMES = {
  error: 'ApiErrorResponse',
  dashboard: 'DashboardResponse',
  operationalSummary: 'OperationalSummaryResponse',
  profit: 'ProfitReportResponse',
  sales: 'SalesReportResponse',
  expenses: 'ExpenseReportResponse',
  moneyMovements: 'MoneyMovementReportResponse',
  liquidity: 'LiquidityReportResponse',
  customerReceivables: 'CustomerReceivableReportResponse',
  supplierPayables: 'SupplierPayableReportResponse',
  inventoryStock: 'InventoryStockReportResponse',
  inventoryMovements: 'InventoryMovementReportResponse',
  returnsCorrections: 'ReturnsCorrectionsReportResponse',
  ownerLedger: 'OwnerLedgerReportResponse',
  search: 'GlobalSearchResponse',
} as const;

export const S20_COMPONENT_SCHEMAS: SchemasObject = {
  ApiErrorResponse: object(
    {
      statusCode: { type: 'integer', minimum: 400, maximum: 599 },
      code: { type: 'string', description: 'Stable machine-readable error code.' },
      message: { type: 'string', description: 'Safe client-facing error summary.' },
      requestId: {
        ...uuid,
        description: 'Request correlation identifier; it is not an authentication credential.',
      },
      timestamp: occurredAt,
      path: { type: 'string' },
      details: { nullable: true, description: 'Optional safe validation or conflict details.' },
    },
    ['statusCode', 'code', 'message', 'requestId', 'timestamp', 'path'],
  ),

  DashboardTodayMetrics: object(
    scalarProperties(
      [
        'salesMinor',
        'immediateSaleCollectionsMinor',
        'customerCollectionsMinor',
        'customerReceivableAllocationsMinor',
        'totalCollectedMinor',
        'creditSalesMinor',
        'expensesRecognizedMinor',
        'supplierPaymentsMinor',
      ],
      moneyMinor,
    ),
  ),
  DashboardMoneyAccount: object({
    id: uuid,
    name: { type: 'string' },
    accountType: stringEnum(['cash', 'transfer']),
    isDefault: { type: 'boolean' },
    balanceMinor: moneyMinor,
  }),
  DashboardMoneyPosition: object({
    accounts: array(reference('DashboardMoneyAccount')),
    totalMinor: moneyMinor,
  }),
  DashboardObligations: object({
    customerReceivablesMinor: moneyMinor,
    supplierPayablesMinor: moneyMinor,
  }),
  DashboardInventoryIndicators: object({
    ...scalarProperties(
      [
        'trackedProductCount',
        'projectedProductCount',
        'missingProjectionCount',
        'positiveStockProductCount',
        'zeroStockProductCount',
        'negativeStockProductCount',
        'knownCostProductCount',
        'unknownCostProductCount',
        'pendingCostProductCount',
      ],
      nonNegativeInteger,
    ),
    knownValueMinor: moneyMinor,
    totalValueMinor: {
      ...nullableMoneyMinor,
      description:
        'Exact inventory value when every tracked cost is known; null preserves unknown/pending cost rather than treating it as zero.',
    },
    valuationStatus: stringEnum(['known', 'partial', 'unknown']),
  }),
  DashboardActivity: object({
    activityType: stringEnum([
      'sale',
      'customer_collection',
      'supplier_invoice',
      'supplier_payment',
      'expense',
      'inventory_movement',
      'sale_return',
      'supplier_return',
    ]),
    resourceId: uuid,
    subtype: nullableString,
    status: nullableString,
    displayNumber: nullableString,
    amountMinor: nullableMoneyMinor,
    quantityDeltaMilli: nullableQuantityMilli,
    businessDate,
    postingDate: nullablePostingDate,
    accountingPeriodId: nullableUuid,
    occurredAt,
  }),
  DashboardResponse: object({
    asOf,
    timezoneName: timezone,
    businessDate,
    today: reference('DashboardTodayMetrics'),
    money: reference('DashboardMoneyPosition'),
    obligations: reference('DashboardObligations'),
    inventory: reference('DashboardInventoryIndicators'),
    recentActivity: object({
      limit: { type: 'integer', enum: [20] },
      items: array(reference('DashboardActivity')),
    }),
  }),

  ReportDateRange: reportDateFilters,
  OperationalSummaryRow: object({
    period: {
      type: 'string',
      description: 'Store-local day (YYYY-MM-DD) or month (YYYY-MM), according to granularity.',
    },
    ...scalarProperties(operationalMoneyFields, moneyMinor),
  }),
  OperationalSummaryTotals: object(scalarProperties(operationalMoneyFields, moneyMinor)),
  OperationalSummaryResponse: object({
    asOf,
    timezoneName: timezone,
    granularity: stringEnum(['day', 'month']),
    dateAuthority: stringEnum(['businessDate']),
    filters: reference('ReportDateRange'),
    rows: array(reference('OperationalSummaryRow')),
    totals: reference('OperationalSummaryTotals'),
  }),
  ProfitReportResponse: object({
    asOf,
    timezoneName: timezone,
    dateAuthority: stringEnum(['postingDate']),
    filters: reference('ReportDateRange'),
    ...scalarProperties(
      [
        'netSalesMinor',
        'grossSalesMinor',
        'saleReturnsMinor',
        'knownCogsMinor',
        'restoredReturnCostMinor',
        'netKnownCogsMinor',
        'expensesMinor',
        'knownInventoryLossesMinor',
      ],
      moneyMinor,
    ),
    profitMinor: {
      ...nullableMoneyMinor,
      description:
        'Operational profit under the canonical S20 report definition; null when cost coverage is incomplete. It is not a statutory Profit and Loss statement.',
    },
    profitCostComplete: { type: 'boolean' },
    unknownReturnCostMovementCount: nonNegativeInteger,
    unknownLossCostMovementCount: nonNegativeInteger,
    costCoverage: object({
      knownLineCount: nonNegativeInteger,
      unknownLineCount: nonNegativeInteger,
      knownPercentage: {
        type: 'string',
        pattern: '^[0-9]+(?:\\.[0-9]+)?$',
        description: 'Exact decimal percentage represented as a string.',
      },
      complete: { type: 'boolean' },
    }),
  }),

  SalesReportRow: object({
    id: uuid,
    displayNumber: { type: 'string' },
    customerId: nullableUuid,
    customerName: nullableString,
    status: stringEnum(['posted', 'cancelled', 'corrected']),
    paymentStatus: stringEnum(['paid', 'partial', 'credit']),
    ...scalarProperties(
      [
        'totalMinor',
        'paidTotalMinor',
        'creditTotalMinor',
        'returnedTotalMinor',
        'knownCostTotalMinor',
      ],
      moneyMinor,
    ),
    pendingCostLineCount: nonNegativeInteger,
    unknownCostLineCount: nonNegativeInteger,
    businessDate,
    postingDate,
    accountingPeriodId: nullableUuid,
    occurredAt,
    correctionOfId: nullableUuid,
    reversedById: nullableUuid,
  }),
  SalesReportTotals: object({
    rowCount: nonNegativeInteger,
    ...scalarProperties(
      [
        'postedTotalMinor',
        'cancelledTotalMinor',
        'correctedTotalMinor',
        'paidTotalMinor',
        'creditTotalMinor',
        'returnedTotalMinor',
        'netPostedSalesMinor',
      ],
      moneyMinor,
    ),
  }),
  SalesReportResponse: pagedReport(
    'SalesReportRow',
    'SalesReportTotals',
    reportFilters({
      fromDate: businessDate,
      toDate: businessDate,
      accountingPeriodId: nullableUuid,
      customerId: nullableUuid,
      status: stringEnum(['posted', 'cancelled', 'corrected', 'all']),
    }),
    ['businessDate'],
  ),

  ExpenseReportRow: object({
    id: uuid,
    categoryId: nullableUuid,
    categoryName: nullableString,
    description: { type: 'string' },
    status: stringEnum(['posted', 'cancelled']),
    paymentTiming: stringEnum(['paid_now', 'due_later']),
    ...scalarProperties(['amountMinor', 'paidMinor', 'outstandingMinor'], moneyMinor),
    businessDate,
    postingDate,
    accountingPeriodId: nullableUuid,
    occurredAt,
  }),
  ExpenseReportTotals: object({
    rowCount: nonNegativeInteger,
    ...scalarProperties(
      ['recognizedMinor', 'cancelledMinor', 'paidMinor', 'outstandingMinor'],
      moneyMinor,
    ),
  }),
  ExpenseReportResponse: pagedReport(
    'ExpenseReportRow',
    'ExpenseReportTotals',
    reportFilters({
      fromDate: businessDate,
      toDate: businessDate,
      accountingPeriodId: nullableUuid,
      categoryId: nullableUuid,
      status: stringEnum(['posted', 'cancelled', 'all']),
    }),
    ['businessDate'],
  ),

  MoneyMovementReportRow: object({
    id: uuid,
    moneyAccountId: uuid,
    moneyAccountName: { type: 'string' },
    movementType: { type: 'string' },
    amountDeltaMinor: moneyMinor,
    referenceType: { type: 'string' },
    referenceId: uuid,
    transactionGroupId: uuid,
    reversalOfId: nullableUuid,
    businessDate,
    postingDate,
    accountingPeriodId: uuid,
    occurredAt,
  }),
  MoneyMovementReportTotals: object({
    rowCount: nonNegativeInteger,
    ...scalarProperties(['inflowMinor', 'outflowMinor', 'netMinor'], moneyMinor),
  }),
  MoneyMovementReportResponse: pagedReport(
    'MoneyMovementReportRow',
    'MoneyMovementReportTotals',
    reportFilters({
      fromDate: businessDate,
      toDate: businessDate,
      accountingPeriodId: nullableUuid,
      moneyAccountId: nullableUuid,
      movementType: nullableString,
    }),
    ['occurredAt'],
  ),

  LiquidityReportRow: object({
    id: uuid,
    name: { type: 'string' },
    accountType: stringEnum(['cash', 'transfer']),
    isDefault: { type: 'boolean' },
    balanceMinor: moneyMinor,
  }),
  LiquidityReportTotals: object({ rowCount: nonNegativeInteger, balanceMinor: moneyMinor }),
  LiquidityReportResponse: pagedReport(
    'LiquidityReportRow',
    'LiquidityReportTotals',
    reportFilters({
      accountType: { ...stringEnum(['cash', 'transfer']), nullable: true },
      status: stringEnum(['active']),
      availability: stringEnum(['available']),
    }),
    ['currentState'],
  ),

  CustomerReceivableReportRow: object({
    id: uuid,
    name: { type: 'string' },
    phone: { type: 'string' },
    status: stringEnum(['active', 'archived']),
    ...scalarProperties(['receivableMinor', 'creditMinor', 'netDueMinor'], moneyMinor),
  }),
  CustomerReceivableReportTotals: object({
    rowCount: nonNegativeInteger,
    ...scalarProperties(['receivableMinor', 'creditMinor', 'netDueMinor'], moneyMinor),
  }),
  CustomerReceivableReportResponse: pagedReport(
    'CustomerReceivableReportRow',
    'CustomerReceivableReportTotals',
    reportFilters({ customerId: nullableUuid }),
    ['currentState'],
  ),

  SupplierPayableReportRow: object({
    id: uuid,
    name: { type: 'string' },
    phone: nullableString,
    status: stringEnum(['active', 'archived']),
    ...scalarProperties(['payableMinor', 'creditMinor', 'netPayableMinor'], moneyMinor),
  }),
  SupplierPayableReportTotals: object({
    rowCount: nonNegativeInteger,
    ...scalarProperties(['payableMinor', 'creditMinor', 'netPayableMinor'], moneyMinor),
  }),
  SupplierPayableReportResponse: pagedReport(
    'SupplierPayableReportRow',
    'SupplierPayableReportTotals',
    reportFilters({ supplierId: nullableUuid }),
    ['currentState'],
  ),

  InventoryStockReportRow: object({
    productId: uuid,
    productName: { type: 'string' },
    productStatus: stringEnum(['active', 'archived']),
    quantityMilli,
    averageUnitCostMinor: {
      ...nullableMoneyMinor,
      description: 'Known average unit cost in minor units, or null when cost is unknown/pending.',
    },
    inventoryValueMinor: {
      ...nullableMoneyMinor,
      description: 'Known projected value, or null when unknown/pending cost prevents valuation.',
    },
    costState: stringEnum(['known', 'unknown', 'pending']),
    hasPendingCost: { type: 'boolean' },
    version: { ...version, nullable: true },
  }),
  InventoryStockReportTotals: object({
    rowCount: nonNegativeInteger,
    knownValueMinor: moneyMinor,
    uncertainProductCount: nonNegativeInteger,
    totalValueMinor: {
      ...nullableMoneyMinor,
      description:
        'Null when any included product has unknown or pending cost; zero is a known value.',
    },
  }),
  InventoryStockReportResponse: pagedReport(
    'InventoryStockReportRow',
    'InventoryStockReportTotals',
    reportFilters({
      productId: nullableUuid,
      trackedOnly: { type: 'boolean', enum: [true] },
    }),
    ['currentState'],
  ),

  InventoryMovementReportRow: object({
    id: uuid,
    productId: uuid,
    productName: { type: 'string' },
    movementType: { type: 'string' },
    quantityDeltaMilli: quantityMilli,
    quantityAfterMilli: quantityMilli,
    valueDeltaMinor: nullableMoneyMinor,
    costStateBefore: stringEnum(['known', 'unknown', 'pending']),
    costStateAfter: stringEnum(['known', 'unknown', 'pending']),
    referenceType: { type: 'string' },
    referenceId: uuid,
    reversalOfId: nullableUuid,
    businessDate,
    postingDate,
    accountingPeriodId: uuid,
    occurredAt,
  }),
  InventoryMovementReportTotals: object({
    rowCount: nonNegativeInteger,
    knownValueDeltaMinor: moneyMinor,
    unknownCostMovementCount: nonNegativeInteger,
  }),
  InventoryMovementReportResponse: pagedReport(
    'InventoryMovementReportRow',
    'InventoryMovementReportTotals',
    reportFilters({
      fromDate: businessDate,
      toDate: businessDate,
      accountingPeriodId: nullableUuid,
      productId: nullableUuid,
      movementType: nullableString,
    }),
    ['postingDate'],
  ),

  ReturnCorrectionReportRow: object({
    id: uuid,
    sourceType: { type: 'string' },
    subtype: { type: 'string' },
    status: nullableString,
    displayNumber: nullableString,
    amountMinor: nullableMoneyMinor,
    quantityDeltaMilli: nullableQuantityMilli,
    reversalOfId: nullableUuid,
    replacementId: nullableUuid,
    businessDate,
    postingDate,
    accountingPeriodId: nullableUuid,
    occurredAt,
  }),
  ReturnCorrectionReportTotals: object({
    rowCount: nonNegativeInteger,
    saleReturnCount: nonNegativeInteger,
    supplierReturnCount: nonNegativeInteger,
    correctionCount: nonNegativeInteger,
  }),
  ReturnsCorrectionsReportResponse: pagedReport(
    'ReturnCorrectionReportRow',
    'ReturnCorrectionReportTotals',
    reportFilters({
      fromDate: businessDate,
      toDate: businessDate,
      accountingPeriodId: nullableUuid,
      sourceType: { type: 'string' },
    }),
    ['postingDate'],
  ),

  OwnerLedgerReportRow: object({
    id: uuid,
    entryType: { type: 'string' },
    ownerLiabilityDeltaMinor: moneyMinor,
    equityDeltaMinor: moneyMinor,
    moneyAccountId: nullableUuid,
    moneyAccountName: nullableString,
    referenceType: nullableString,
    referenceId: nullableUuid,
    reversalOfId: nullableUuid,
    businessDate,
    postingDate,
    accountingPeriodId: uuid,
    occurredAt,
  }),
  OwnerLedgerReportTotals: object({
    rowCount: nonNegativeInteger,
    ownerLiabilityDeltaMinor: moneyMinor,
    equityDeltaMinor: moneyMinor,
  }),
  OwnerLedgerReportResponse: pagedReport(
    'OwnerLedgerReportRow',
    'OwnerLedgerReportTotals',
    reportFilters({
      fromDate: businessDate,
      toDate: businessDate,
      accountingPeriodId: nullableUuid,
      entryType: nullableString,
    }),
    ['occurredAt'],
    {
      currentPosition: object({
        storeOwesOwnerMinor: moneyMinor,
        ownerEquityMovementMinor: moneyMinor,
      }),
    },
  ),

  SearchResult: object({
    type: stringEnum([
      'customer',
      'supplier',
      'product',
      'sale',
      'supplier_invoice',
      'expense',
      'customer_collection',
      'supplier_payment',
      'money_account',
      'money_movement',
      'sale_return',
      'supplier_return',
      'inventory_movement',
    ]),
    id: uuid,
    primaryLabel: { type: 'string' },
    secondaryLabel: nullableString,
    status: nullableString,
    displayNumber: nullableString,
    amountMinor: nullableMoneyMinor,
    quantityMilli: nullableQuantityMilli,
    businessDate: { ...businessDate, nullable: true },
    occurredAt: nullableOccurredAt,
  }),
  GlobalSearchResponse: object({
    filters: object({
      q: { type: 'string' },
      type: {
        ...stringEnum([
          'customer',
          'supplier',
          'product',
          'sale',
          'supplier_invoice',
          'expense',
          'customer_collection',
          'supplier_payment',
          'money_account',
          'money_movement',
          'sale_return',
          'supplier_return',
          'inventory_movement',
        ]),
        nullable: true,
      },
    }),
    items: array(reference('SearchResult')),
    pagination: object({
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      nextCursor: {
        type: 'string',
        nullable: true,
        maxLength: 256,
        description:
          'Opaque, Store- and search-scope-bound keyset cursor. Reuse unchanged with the same q/type filters.',
      },
    }),
  }),
};

export function schemaReference(name: string): ReferenceObject {
  return reference(name);
}
