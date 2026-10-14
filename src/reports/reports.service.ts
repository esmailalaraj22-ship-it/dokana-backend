import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type {
  CustomerReceivableReportQueryDto,
  ExpenseReportQueryDto,
  InventoryMovementReportQueryDto,
  InventoryStockReportQueryDto,
  LiquidityReportQueryDto,
  MoneyMovementReportQueryDto,
  OwnerLedgerReportQueryDto,
  ReportDateRangeQueryDto,
  ReturnsCorrectionsReportQueryDto,
  SalesReportQueryDto,
  SupplierPayableReportQueryDto,
} from './dto/report-query.dto';
import {
  decodeReportCursor,
  encodeReportCursor,
  reportCursorScopeHash,
  type ReportCursor,
} from './report-cursor';
import { ReportsRepository } from './reports.repository';
import type {
  CustomerReceivableReportRow,
  CustomerReceivableReportTotals,
  ExpenseReportRow,
  ExpenseReportTotals,
  InventoryMovementReportRow,
  InventoryMovementReportTotals,
  InventoryStockReportRow,
  InventoryStockReportTotals,
  LiquidityReportRow,
  LiquidityReportTotals,
  MoneyMovementReportRow,
  MoneyMovementReportTotals,
  OperationalSummaryResponse,
  OwnerLedgerReportExtra,
  OwnerLedgerReportRow,
  OwnerLedgerReportTotals,
  ProfitReportResponse,
  ReportPageData,
  ReportPageResponse,
  ReturnCorrectionReportRow,
  ReturnCorrectionReportTotals,
  SalesReportRow,
  SalesReportTotals,
  SupplierPayableReportRow,
  SupplierPayableReportTotals,
} from './reports.types';

type ReportsPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

const DEFAULT_LIMIT = 50;
const MAX_DAILY_RANGE_DAYS = 366;
const MAX_REPORT_RANGE_DAYS = 3660;

@Injectable()
export class ReportsService {
  constructor(private readonly repository: ReportsRepository) {}

  async readDaily(
    principal: ReportsPrincipal,
    context: TenantTransactionContext,
    query: ReportDateRangeQueryDto,
  ): Promise<OperationalSummaryResponse> {
    this.assertAuthorized(principal, context);
    this.assertDateRange(query.fromDate, query.toDate, MAX_DAILY_RANGE_DAYS);
    const result = await this.repository.readOperationalSummary(context, {
      ...query,
      granularity: 'day',
    });
    return { ...result, asOf: result.asOf.toISOString() };
  }

  async readMonthly(
    principal: ReportsPrincipal,
    context: TenantTransactionContext,
    query: ReportDateRangeQueryDto,
  ): Promise<OperationalSummaryResponse> {
    this.assertAuthorized(principal, context);
    this.assertDateRange(query.fromDate, query.toDate, MAX_REPORT_RANGE_DAYS);
    const result = await this.repository.readOperationalSummary(context, {
      ...query,
      granularity: 'month',
    });
    return { ...result, asOf: result.asOf.toISOString() };
  }

  async readProfit(
    principal: ReportsPrincipal,
    context: TenantTransactionContext,
    query: ReportDateRangeQueryDto,
  ): Promise<ProfitReportResponse> {
    this.assertAuthorized(principal, context);
    this.assertDateRange(query.fromDate, query.toDate, MAX_REPORT_RANGE_DAYS);
    const result = await this.repository.readProfit(context, query);
    return { ...result, asOf: result.asOf.toISOString() };
  }

  readSales(
    principal: ReportsPrincipal,
    context: TenantTransactionContext,
    query: SalesReportQueryDto,
  ): Promise<ReportPageResponse<SalesReportRow, SalesReportTotals, Record<string, unknown>>> {
    this.assertAuthorized(principal, context);
    this.assertDateRange(query.fromDate, query.toDate, MAX_REPORT_RANGE_DAYS);
    const status = query.status ?? 'all';
    const scope = [
      query.fromDate,
      query.toDate,
      query.accountingPeriodId ?? null,
      query.customerId ?? null,
      status,
    ];
    return this.readPage(
      'sales',
      scope,
      query,
      (cursor, limit) =>
        this.repository.readSales(context, {
          ...query,
          status,
          limit,
          cursorId: cursor?.anchorId ?? null,
        }),
      (row) => ({ id: row.id, type: null }),
      'businessDate',
      {
        fromDate: query.fromDate,
        toDate: query.toDate,
        accountingPeriodId: query.accountingPeriodId ?? null,
        customerId: query.customerId ?? null,
        status,
      },
    );
  }

  readExpenses(
    principal: ReportsPrincipal,
    context: TenantTransactionContext,
    query: ExpenseReportQueryDto,
  ): Promise<ReportPageResponse<ExpenseReportRow, ExpenseReportTotals, Record<string, unknown>>> {
    this.assertAuthorized(principal, context);
    this.assertDateRange(query.fromDate, query.toDate, MAX_REPORT_RANGE_DAYS);
    const status = query.status ?? 'all';
    const scope = [
      query.fromDate,
      query.toDate,
      query.accountingPeriodId ?? null,
      query.categoryId ?? null,
      status,
    ];
    return this.readPage(
      'expenses',
      scope,
      query,
      (cursor, limit) =>
        this.repository.readExpenses(context, {
          ...query,
          status,
          limit,
          cursorId: cursor?.anchorId ?? null,
        }),
      (row) => ({ id: row.id, type: null }),
      'businessDate',
      {
        fromDate: query.fromDate,
        toDate: query.toDate,
        accountingPeriodId: query.accountingPeriodId ?? null,
        categoryId: query.categoryId ?? null,
        status,
      },
    );
  }

  readMoneyMovements(
    principal: ReportsPrincipal,
    context: TenantTransactionContext,
    query: MoneyMovementReportQueryDto,
  ): Promise<
    ReportPageResponse<MoneyMovementReportRow, MoneyMovementReportTotals, Record<string, unknown>>
  > {
    this.assertAuthorized(principal, context);
    this.assertDateRange(query.fromDate, query.toDate, MAX_REPORT_RANGE_DAYS);
    const scope = [
      query.fromDate,
      query.toDate,
      query.accountingPeriodId ?? null,
      query.moneyAccountId ?? null,
      query.movementType ?? null,
    ];
    return this.readPage(
      'money-movements',
      scope,
      query,
      (cursor, limit) =>
        this.repository.readMoneyMovements(context, {
          ...query,
          limit,
          cursorId: cursor?.anchorId ?? null,
        }),
      (row) => ({ id: row.id, type: null }),
      'occurredAt',
      {
        fromDate: query.fromDate,
        toDate: query.toDate,
        accountingPeriodId: query.accountingPeriodId ?? null,
        moneyAccountId: query.moneyAccountId ?? null,
        movementType: query.movementType ?? null,
      },
    );
  }

  readLiquidity(
    principal: ReportsPrincipal,
    context: TenantTransactionContext,
    query: LiquidityReportQueryDto,
  ): Promise<
    ReportPageResponse<LiquidityReportRow, LiquidityReportTotals, Record<string, unknown>>
  > {
    this.assertAuthorized(principal, context);
    const scope = [query.accountType ?? null];
    return this.readPage(
      'liquidity',
      scope,
      query,
      (cursor, limit) =>
        this.repository.readLiquidity(context, {
          ...query,
          limit,
          cursorId: cursor?.anchorId ?? null,
        }),
      (row) => ({ id: row.id, type: null }),
      'currentState',
      { accountType: query.accountType ?? null, status: 'active', availability: 'available' },
    );
  }

  readCustomerReceivables(
    principal: ReportsPrincipal,
    context: TenantTransactionContext,
    query: CustomerReceivableReportQueryDto,
  ): Promise<
    ReportPageResponse<
      CustomerReceivableReportRow,
      CustomerReceivableReportTotals,
      Record<string, unknown>
    >
  > {
    this.assertAuthorized(principal, context);
    const scope = [query.customerId ?? null];
    return this.readPage(
      'customer-receivables',
      scope,
      query,
      (cursor, limit) =>
        this.repository.readCustomerReceivables(context, {
          ...query,
          limit,
          cursorId: cursor?.anchorId ?? null,
        }),
      (row) => ({ id: row.id, type: null }),
      'currentState',
      { customerId: query.customerId ?? null },
    );
  }

  readSupplierPayables(
    principal: ReportsPrincipal,
    context: TenantTransactionContext,
    query: SupplierPayableReportQueryDto,
  ): Promise<
    ReportPageResponse<
      SupplierPayableReportRow,
      SupplierPayableReportTotals,
      Record<string, unknown>
    >
  > {
    this.assertAuthorized(principal, context);
    const scope = [query.supplierId ?? null];
    return this.readPage(
      'supplier-payables',
      scope,
      query,
      (cursor, limit) =>
        this.repository.readSupplierPayables(context, {
          ...query,
          limit,
          cursorId: cursor?.anchorId ?? null,
        }),
      (row) => ({ id: row.id, type: null }),
      'currentState',
      { supplierId: query.supplierId ?? null },
    );
  }

  readInventoryStock(
    principal: ReportsPrincipal,
    context: TenantTransactionContext,
    query: InventoryStockReportQueryDto,
  ): Promise<
    ReportPageResponse<InventoryStockReportRow, InventoryStockReportTotals, Record<string, unknown>>
  > {
    this.assertAuthorized(principal, context);
    const scope = [query.productId ?? null];
    return this.readPage(
      'inventory-stock',
      scope,
      query,
      (cursor, limit) =>
        this.repository.readInventoryStock(context, {
          ...query,
          limit,
          cursorId: cursor?.anchorId ?? null,
        }),
      (row) => ({ id: row.productId, type: null }),
      'currentState',
      { productId: query.productId ?? null, trackedOnly: true },
    );
  }

  readInventoryMovements(
    principal: ReportsPrincipal,
    context: TenantTransactionContext,
    query: InventoryMovementReportQueryDto,
  ): Promise<
    ReportPageResponse<
      InventoryMovementReportRow,
      InventoryMovementReportTotals,
      Record<string, unknown>
    >
  > {
    this.assertAuthorized(principal, context);
    this.assertDateRange(query.fromDate, query.toDate, MAX_REPORT_RANGE_DAYS);
    const scope = [
      query.fromDate,
      query.toDate,
      query.accountingPeriodId ?? null,
      query.productId ?? null,
      query.movementType ?? null,
    ];
    return this.readPage(
      'inventory-movements',
      scope,
      query,
      (cursor, limit) =>
        this.repository.readInventoryMovements(context, {
          ...query,
          limit,
          cursorId: cursor?.anchorId ?? null,
        }),
      (row) => ({ id: row.id, type: null }),
      'postingDate',
      {
        fromDate: query.fromDate,
        toDate: query.toDate,
        accountingPeriodId: query.accountingPeriodId ?? null,
        productId: query.productId ?? null,
        movementType: query.movementType ?? null,
      },
    );
  }

  readReturnsCorrections(
    principal: ReportsPrincipal,
    context: TenantTransactionContext,
    query: ReturnsCorrectionsReportQueryDto,
  ): Promise<
    ReportPageResponse<
      ReturnCorrectionReportRow,
      ReturnCorrectionReportTotals,
      Record<string, unknown>
    >
  > {
    this.assertAuthorized(principal, context);
    this.assertDateRange(query.fromDate, query.toDate, MAX_REPORT_RANGE_DAYS);
    const sourceType = query.sourceType ?? 'all';
    const scope = [query.fromDate, query.toDate, query.accountingPeriodId ?? null, sourceType];
    return this.readPage(
      'returns-corrections',
      scope,
      query,
      (cursor, limit) =>
        this.repository.readReturnsCorrections(context, {
          ...query,
          sourceType,
          limit,
          cursorId: cursor?.anchorId ?? null,
          cursorSourceType: cursor?.anchorType ?? null,
        }),
      (row) => ({ id: row.id, type: row.sourceType }),
      'postingDate',
      {
        fromDate: query.fromDate,
        toDate: query.toDate,
        accountingPeriodId: query.accountingPeriodId ?? null,
        sourceType,
      },
      true,
    );
  }

  async readOwnerLedger(
    principal: ReportsPrincipal,
    context: TenantTransactionContext,
    query: OwnerLedgerReportQueryDto,
  ): Promise<
    ReportPageResponse<OwnerLedgerReportRow, OwnerLedgerReportTotals, Record<string, unknown>> &
      OwnerLedgerReportExtra
  > {
    this.assertAuthorized(principal, context);
    this.assertDateRange(query.fromDate, query.toDate, MAX_REPORT_RANGE_DAYS);
    const scope = [
      query.fromDate,
      query.toDate,
      query.accountingPeriodId ?? null,
      query.entryType ?? null,
    ];
    const limit = query.limit ?? DEFAULT_LIMIT;
    const cursor = this.cursor('owner-ledger', scope, query.cursor, false);
    const result = await this.repository.readOwnerLedger(context, {
      ...query,
      limit,
      cursorId: cursor?.anchorId ?? null,
    });
    const page = this.mapPage(
      'owner-ledger',
      scope,
      limit,
      result,
      (row) => ({ id: row.id, type: null }),
      'occurredAt',
      {
        fromDate: query.fromDate,
        toDate: query.toDate,
        accountingPeriodId: query.accountingPeriodId ?? null,
        entryType: query.entryType ?? null,
      },
    );
    return { ...page, currentPosition: result.currentPosition };
  }

  private async readPage<Item, Totals>(
    family: string,
    scopeValues: readonly unknown[],
    query: { limit?: number; cursor?: string },
    read: (cursor: ReportCursor | null, limit: number) => Promise<ReportPageData<Item, Totals>>,
    anchor: (item: Item) => { id: string; type: string | null },
    dateAuthority: ReportPageResponse<Item, Totals, Record<string, unknown>>['dateAuthority'],
    filters: Record<string, unknown>,
    allowTypedCursor = false,
  ): Promise<ReportPageResponse<Item, Totals, Record<string, unknown>>> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const cursor = this.cursor(family, scopeValues, query.cursor, allowTypedCursor);
    const result = await read(cursor, limit);
    return this.mapPage(family, scopeValues, limit, result, anchor, dateAuthority, filters);
  }

  private mapPage<Item, Totals>(
    family: string,
    scopeValues: readonly unknown[],
    limit: number,
    result: ReportPageData<Item, Totals>,
    anchor: (item: Item) => { id: string; type: string | null },
    dateAuthority: ReportPageResponse<Item, Totals, Record<string, unknown>>['dateAuthority'],
    filters: Record<string, unknown>,
  ): ReportPageResponse<Item, Totals, Record<string, unknown>> {
    const scopeHash = reportCursorScopeHash(family, scopeValues);
    const last = result.items.at(-1);
    const nextAnchor = result.hasMore && last ? anchor(last) : null;
    return {
      asOf: result.asOf.toISOString(),
      timezoneName: 'Asia/Hebron',
      dateAuthority,
      filters,
      items: result.items,
      totals: { page: result.pageTotals, filtered: result.filteredTotals },
      pagination: {
        limit,
        nextCursor: nextAnchor
          ? encodeReportCursor({
              scopeHash,
              anchorId: nextAnchor.id,
              anchorType: nextAnchor.type,
            })
          : null,
      },
    };
  }

  private cursor(
    family: string,
    scopeValues: readonly unknown[],
    encoded: string | undefined,
    allowTypedCursor: boolean,
  ): ReportCursor | null {
    if (!encoded) return null;
    const cursor = decodeReportCursor(encoded, reportCursorScopeHash(family, scopeValues));
    if (
      (!allowTypedCursor && cursor.anchorType !== null) ||
      (allowTypedCursor && !cursor.anchorType)
    ) {
      throw this.invalidQuery('cursor', 'reportCursorType');
    }
    return cursor;
  }

  private assertAuthorized(principal: ReportsPrincipal, context: TenantTransactionContext): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'REPORT_READ_NOT_ALLOWED',
        message: 'Report reads are not allowed.',
      });
    }
  }

  private assertDateRange(fromDate: string, toDate: string, maximumDays: number): void {
    const from = this.parseDate(fromDate, 'fromDate');
    const to = this.parseDate(toDate, 'toDate');
    const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days < 1 || days > maximumDays) {
      throw this.invalidQuery('toDate', 'reportDateRange');
    }
  }

  private parseDate(value: string, field: string): Date {
    const result = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value) {
      throw this.invalidQuery(field, 'calendarDate');
    }
    return result;
  }

  private invalidQuery(field: string, constraint: string): BadRequestException {
    return new BadRequestException({
      code: 'REPORT_QUERY_INVALID',
      message: 'Report query is invalid.',
      details: [{ field, constraint }],
    });
  }
}
