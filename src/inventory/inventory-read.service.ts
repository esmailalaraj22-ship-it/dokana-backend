import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { isUuid } from '../common/logging/request-id';
import type { TenantTransactionContext } from '../database/database.types';
import { inventoryCostResponse, inventoryUnitCost } from './inventory-math';
import { InventoryReadRepository } from './inventory-read.repository';
import type {
  InventoryOperationResponse,
  InventoryReadPrincipal,
  InventoryStockResponse,
} from './inventory-read.types';

@Injectable()
export class InventoryReadService {
  constructor(private readonly repository: InventoryReadRepository) {}

  async stock(
    principal: InventoryReadPrincipal,
    context: TenantTransactionContext,
    productId: string,
  ): Promise<InventoryStockResponse> {
    this.authorize(principal, context);
    const record = await this.repository.findStock(
      context,
      this.identifier(productId, 'productId'),
    );
    if (!record)
      throw new NotFoundException({
        code: 'INVENTORY_PRODUCT_NOT_FOUND',
        message: 'Inventory Product not found.',
      });
    const { product, balance, units } = record;
    const baseCandidates = units.filter((unit) => unit.isBase);
    const activeBase = baseCandidates.filter((unit) => unit.status === 'active');
    const bases = activeBase.length ? activeBase : baseCandidates;
    if (
      bases.length > 1 ||
      units.some((unit) => unit.measurementType !== product.measurementType)
    ) {
      throw new ConflictException({
        code: 'INVENTORY_STATE_INVALID',
        message: 'Inventory unit structure is unavailable.',
      });
    }
    const result: InventoryStockResponse = {
      productId: product.id,
      trackingState: product.trackInventory ? 'TRACKED' : 'NOT_TRACKED',
      projectionState: !product.trackInventory ? 'NOT_TRACKED' : balance ? 'PRESENT' : 'MISSING',
      baseUnit: bases[0] ?? null,
      units,
      stock: null,
    };
    // A missing projection is not a persisted zero/version. GET never initializes it.
    if (!product.trackInventory || !balance) return result;
    const average =
      balance.costState === 'known' && balance.quantityMilli > 0n
        ? inventoryUnitCost(balance.inventoryValueMinor, balance.quantityMilli)
        : balance.averageUnitCostMinor;
    result.stock = {
      baseQuantityMilli: balance.quantityMilli.toString(),
      quantityState:
        balance.quantityMilli > 0n ? 'POSITIVE' : balance.quantityMilli < 0n ? 'NEGATIVE' : 'ZERO',
      version: balance.version.toString(),
      lastMovementId: balance.lastMovementId,
      updatedAt: balance.updatedAt.toISOString(),
      cost: inventoryCostResponse(balance.costState, balance.inventoryValueMinor, average),
    };
    return result;
  }

  async operation(
    principal: InventoryReadPrincipal,
    context: TenantTransactionContext,
    operationId: string,
  ): Promise<InventoryOperationResponse> {
    this.authorize(principal, context);
    const record = await this.repository.findOperation(
      context,
      this.identifier(operationId, 'operationId'),
    );
    if (!record)
      throw new NotFoundException({
        code: 'INVENTORY_OPERATION_NOT_FOUND',
        message: 'Inventory operation not found.',
      });
    const { entry: e, movement: m } = record;
    return {
      id: e.id,
      operationId: e.operationId,
      productId: e.productId,
      productUnitId: e.productUnitId,
      selectedQuantityMilli: e.selectedQuantityMilli.toString(),
      baseQuantityMilli: e.baseQuantityMilli.toString(),
      factorNum: e.factorNum,
      factorDen: e.factorDen,
      totalPurchaseCostMinor: e.totalPurchaseCostMinor?.toString() ?? null,
      costStatus: e.costStatus,
      occurredAt: e.occurredAt.toISOString(),
      businessDate: e.businessDate,
      postingDate: e.postingDate,
      accountingPeriodId: e.accountingPeriodId,
      transactionGroupId: e.transactionGroupId,
      deviceId: e.deviceId,
      reason: e.reason,
      createdAt: e.createdAt.toISOString(),
      movement: {
        id: m.id,
        operationId: m.operationId,
        movementType: m.movementType,
        reversalOfId: m.reversalOfId,
        quantityBeforeMilli: m.quantityBeforeMilli.toString(),
        quantityDeltaMilli: m.quantityDeltaMilli.toString(),
        quantityAfterMilli: m.quantityAfterMilli.toString(),
        costBefore: inventoryCostResponse(m.costStateBefore, m.inventoryValueBeforeMinor, null),
        costAfter: inventoryCostResponse(
          m.costStateAfter,
          m.inventoryValueAfterMinor,
          m.averageUnitCostAfterMinor,
        ),
        valueDeltaMinor:
          m.costStateBefore === 'known' && m.costStateAfter === 'known'
            ? m.valueDeltaMinor.toString()
            : null,
      },
    };
  }

  private authorize(principal: InventoryReadPrincipal, context: TenantTransactionContext): void {
    // PRD MVP operational reads belong to the owner; read_only is not a write gate.
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'INVENTORY_READ_NOT_ALLOWED',
        message: 'Inventory reads are not allowed.',
      });
    }
  }

  private identifier(value: string, field: string): string {
    if (!isUuid(value))
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: [{ field, constraints: ['isUuid'] }],
      });
    return value.toLowerCase();
  }
}
