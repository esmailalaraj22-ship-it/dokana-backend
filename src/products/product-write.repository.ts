import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { products, productUnits, stores } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  mapProductMutationResponse,
  mapProductUnitMutationResponse,
  parseStoredProductMutationResponse,
  parseStoredProductUnitMutationResponse,
} from './product-write-response';
import type { ProductDetailRow, ProductUnitRow } from './product-read.types';
import type {
  ProductMutationFailure,
  ProductMutationFailureCode,
  ProductMutationResponse,
  ProductMutationResult,
  ProductUnitMutationResponse,
  PreparedProductCreate,
  PreparedProductLifecycle,
  PreparedProductUnitCreate,
  PreparedProductUnitLifecycle,
  PreparedProductUnitUpdate,
  PreparedProductUpdate,
} from './product-write.types';

const productSelection = {
  id: products.id,
  name: products.name,
  normalizedName: products.normalizedName,
  sku: products.sku,
  barcode: products.barcode,
  description: products.description,
  measurementType: products.measurementType,
  trackInventory: products.trackInventory,
  allowNegativeStockOverride: products.allowNegativeStockOverride,
  lowStockThresholdMilli: products.lowStockThresholdMilli,
  isPinned: products.isPinned,
  status: products.status,
  archivedAt: products.archivedAt,
  createdAt: products.createdAt,
  updatedAt: products.updatedAt,
  version: products.version,
} as const;

const unitSelection = {
  id: productUnits.id,
  measurementType: productUnits.measurementType,
  unitName: productUnits.unitName,
  unitCode: productUnits.unitCode,
  isBase: productUnits.isBase,
  factorNum: productUnits.factorNum,
  factorDen: productUnits.factorDen,
  salePriceMinor: productUnits.salePriceMinor,
  purchasePriceMinor: productUnits.purchasePriceMinor,
  status: productUnits.status,
  createdAt: productUnits.createdAt,
  updatedAt: productUnits.updatedAt,
  version: productUnits.version,
} as const;

const failureDefinitions: Readonly<Record<ProductMutationFailureCode, ProductMutationFailure>> = {
  CONFLICT: {
    code: 'CONFLICT',
    message: 'The request conflicts with existing state.',
    statusCode: 409,
  },
  PRODUCT_NOT_FOUND: { code: 'PRODUCT_NOT_FOUND', message: 'Product not found.', statusCode: 404 },
  PRODUCT_ARCHIVED: {
    code: 'PRODUCT_ARCHIVED',
    message: 'Archived Product cannot be modified.',
    statusCode: 409,
  },
  PRODUCT_UNIT_NOT_FOUND: {
    code: 'PRODUCT_UNIT_NOT_FOUND',
    message: 'Product Unit not found.',
    statusCode: 404,
  },
  PRODUCT_UNIT_ARCHIVED: {
    code: 'PRODUCT_UNIT_ARCHIVED',
    message: 'Archived Product Unit cannot be modified.',
    statusCode: 409,
  },
  PRODUCT_SKU_CONFLICT: {
    code: 'PRODUCT_SKU_CONFLICT',
    message: 'A Product with this SKU already exists.',
    statusCode: 409,
  },
  PRODUCT_BARCODE_CONFLICT: {
    code: 'PRODUCT_BARCODE_CONFLICT',
    message: 'A Product with this barcode already exists.',
    statusCode: 409,
  },
  PRODUCT_UNIT_NAME_CONFLICT: {
    code: 'PRODUCT_UNIT_NAME_CONFLICT',
    message: 'A Product Unit with this name already exists.',
    statusCode: 409,
  },
  PRODUCT_BASE_UNIT_REQUIRED: {
    code: 'PRODUCT_BASE_UNIT_REQUIRED',
    message: 'An active base Unit is required before adding a conversion Unit.',
    statusCode: 409,
  },
  PRODUCT_VERSION_CONFLICT: {
    code: 'PRODUCT_VERSION_CONFLICT',
    message: 'Product version conflict.',
    statusCode: 409,
  },
  PRODUCT_UNIT_VERSION_CONFLICT: {
    code: 'PRODUCT_UNIT_VERSION_CONFLICT',
    message: 'Product Unit version conflict.',
    statusCode: 409,
  },
  OPERATION_ID_CONFLICT: {
    code: 'OPERATION_ID_CONFLICT',
    message: 'Operation ID was reused with a different request.',
    statusCode: 409,
  },
  OPERATION_IN_PROGRESS: {
    code: 'OPERATION_IN_PROGRESS',
    message: 'The operation is still being processed.',
    statusCode: 409,
  },
};

interface MutationOperation {
  aggregateType: 'products' | 'product_units';
  aggregateId: string;
  operationId: string;
  requestHash: string;
  action: 'create' | 'update' | 'archive' | 'restore';
  expectedVersion?: bigint;
}

interface ProcessedOperationRow extends Record<string, unknown> {
  deviceId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  requestHash: string;
  status: 'processing' | 'applied' | 'rejected';
  responseCode: number | null;
  responseBody: unknown;
  errorCode: string | null;
}

interface PostgreSqlError {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

class NestedConflict extends Error {
  constructor(public readonly which: 'product' | 'unit') {
    super('nested-conflict');
  }
}

interface FailureResult {
  ok: false;
  error: ProductMutationFailure;
}

function failure(code: ProductMutationFailureCode): FailureResult {
  return { ok: false, error: failureDefinitions[code] };
}

function databaseError(error: unknown): PostgreSqlError | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate: PostgreSqlError = {
    code: 'code' in error ? error.code : undefined,
    constraint: 'constraint' in error ? error.constraint : undefined,
    cause: 'cause' in error ? error.cause : undefined,
  };
  if (candidate.code !== undefined || candidate.constraint !== undefined) {
    return candidate;
  }
  return candidate.cause === error ? undefined : databaseError(candidate.cause);
}

function uniqueConstraint(error: unknown): string | undefined {
  const postgresError = databaseError(error);
  if (postgresError?.code !== '23505') {
    return undefined;
  }
  return typeof postgresError.constraint === 'string' ? postgresError.constraint : '';
}

@Injectable()
export class ProductWriteRepository {
  constructor(private readonly database: DatabaseService) {}

  createProduct(
    context: TenantTransactionContext,
    input: PreparedProductCreate,
  ): Promise<ProductMutationResult<ProductMutationResponse>> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const operation: MutationOperation = {
        aggregateType: 'products',
        aggregateId: input.productId,
        operationId: input.operationId,
        requestHash: input.requestHash,
        action: 'create',
      };
      const begun = await this.beginMutation(
        transaction,
        context,
        operation,
        parseStoredProductMutationResponse,
      );
      if (begun) {
        return begun;
      }

      let created: { product: ProductDetailRow; unit: ProductUnitRow };
      try {
        created = await transaction.transaction(async (savepoint) => {
          const productRows = await savepoint
            .insert(products)
            .values({
              id: input.productId,
              storeId: context.storeId,
              name: input.name,
              normalizedName: input.normalizedName,
              sku: input.sku,
              barcode: input.barcode,
              description: input.description,
              measurementType: input.measurementType,
              trackInventory: input.trackInventory,
              allowNegativeStockOverride: input.allowNegativeStockOverride,
              lowStockThresholdMilli: input.lowStockThresholdMilli,
              isPinned: input.isPinned,
              status: 'active',
              archivedAt: null,
              deviceId: context.deviceId,
              operationId: input.operationId,
            })
            .onConflictDoNothing()
            .returning(productSelection);
          const product = productRows[0];
          if (!product) {
            throw new NestedConflict('product');
          }
          const unitRows = await savepoint
            .insert(productUnits)
            .values({
              id: input.baseUnit.unitId,
              storeId: context.storeId,
              productId: input.productId,
              measurementType: input.measurementType,
              unitName: input.baseUnit.unitName,
              unitCode: input.baseUnit.unitCode,
              isBase: true,
              factorNum: 1,
              factorDen: 1,
              salePriceMinor: input.baseUnit.salePriceMinor,
              purchasePriceMinor: input.baseUnit.purchasePriceMinor,
              status: 'active',
              deviceId: context.deviceId,
              operationId: input.operationId,
            })
            .onConflictDoNothing()
            .returning(unitSelection);
          const unit = unitRows[0];
          if (!unit) {
            throw new NestedConflict('unit');
          }
          return { product, unit };
        });
      } catch (error) {
        const conflict = await this.classifyCreateFailure(transaction, context, input, error);
        if (!conflict) {
          throw error;
        }
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }

      const response = mapProductMutationResponse(
        created.product,
        [created.unit],
        input.operationId,
      );
      await this.applyOperation(transaction, context.storeId, input.operationId, 201, response);
      return { ok: true, response };
    });
  }

  updateProduct(
    context: TenantTransactionContext,
    input: PreparedProductUpdate,
  ): Promise<ProductMutationResult<ProductMutationResponse>> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const operation: MutationOperation = {
        aggregateType: 'products',
        aggregateId: input.productId,
        operationId: input.operationId,
        requestHash: input.requestHash,
        action: 'update',
        expectedVersion: input.expectedVersion,
      };
      const begun = await this.beginMutation(
        transaction,
        context,
        operation,
        parseStoredProductMutationResponse,
      );
      if (begun) {
        return begun;
      }

      const currentRows = await transaction
        .select(productSelection)
        .from(products)
        .where(and(eq(products.storeId, context.storeId), eq(products.id, input.productId)))
        .limit(1)
        .for('update');
      const current = currentRows[0];
      const stateConflict = this.classifyProductState(current, input.expectedVersion);
      if (stateConflict) {
        await this.rejectOperation(transaction, context.storeId, input.operationId, stateConflict);
        return stateConflict;
      }
      const currentProduct = current as ProductDetailRow;

      let product: ProductDetailRow;
      if (this.isProductNoOp(currentProduct, input)) {
        product = currentProduct;
      } else {
        const updates = this.buildProductUpdates(context, input);
        let rows: ProductDetailRow[];
        try {
          rows = await transaction.transaction((savepoint) =>
            savepoint
              .update(products)
              .set(updates)
              .where(
                and(
                  eq(products.storeId, context.storeId),
                  eq(products.id, input.productId),
                  eq(products.status, 'active'),
                  eq(products.version, input.expectedVersion),
                ),
              )
              .returning(productSelection),
          );
        } catch (error) {
          const conflict = this.classifyProductConstraint(error);
          if (!conflict) {
            throw error;
          }
          await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
          return conflict;
        }
        const updated = rows[0];
        if (!updated) {
          throw new Error('Locked Product update did not return a row.');
        }
        product = updated;
      }

      const units = await this.loadUnits(transaction, context, input.productId);
      const response = mapProductMutationResponse(product, units, input.operationId);
      await this.applyOperation(transaction, context.storeId, input.operationId, 200, response);
      return { ok: true, response };
    });
  }

  createUnit(
    context: TenantTransactionContext,
    input: PreparedProductUnitCreate,
  ): Promise<ProductMutationResult<ProductUnitMutationResponse>> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const operation: MutationOperation = {
        aggregateType: 'product_units',
        aggregateId: input.unitId,
        operationId: input.operationId,
        requestHash: input.requestHash,
        action: 'create',
      };
      const begun = await this.beginMutation(
        transaction,
        context,
        operation,
        parseStoredProductUnitMutationResponse,
      );
      if (begun) {
        return begun;
      }

      const productRows = await transaction
        .select({
          measurementType: products.measurementType,
          status: products.status,
        })
        .from(products)
        .where(and(eq(products.storeId, context.storeId), eq(products.id, input.productId)))
        .limit(1)
        .for('update');
      const product = productRows[0];
      if (!product) {
        const conflict = failure('PRODUCT_NOT_FOUND');
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }
      if (product.status !== 'active') {
        const conflict = failure('PRODUCT_ARCHIVED');
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }

      const activeBase = await transaction
        .select({ id: productUnits.id })
        .from(productUnits)
        .where(
          and(
            eq(productUnits.storeId, context.storeId),
            eq(productUnits.productId, input.productId),
            eq(productUnits.isBase, true),
            eq(productUnits.status, 'active'),
          ),
        )
        .limit(1);
      if (!activeBase[0]) {
        const conflict = failure('PRODUCT_BASE_UNIT_REQUIRED');
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }

      let rows: ProductUnitRow[];
      try {
        rows = await transaction.transaction((savepoint) =>
          savepoint
            .insert(productUnits)
            .values({
              id: input.unitId,
              storeId: context.storeId,
              productId: input.productId,
              measurementType: product.measurementType,
              unitName: input.unitName,
              unitCode: input.unitCode,
              isBase: false,
              factorNum: input.factorNum,
              factorDen: input.factorDen,
              salePriceMinor: input.salePriceMinor,
              purchasePriceMinor: input.purchasePriceMinor,
              status: 'active',
              deviceId: context.deviceId,
              operationId: input.operationId,
            })
            .onConflictDoNothing()
            .returning(unitSelection),
        );
      } catch (error) {
        const conflict = this.classifyUnitConstraint(error);
        if (!conflict) {
          throw error;
        }
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }

      const unit = rows[0];
      if (!unit) {
        const conflict = await this.classifyUnitCreateConflict(transaction, context, input);
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }

      const response = mapProductUnitMutationResponse(unit, input.productId, input.operationId);
      await this.applyOperation(transaction, context.storeId, input.operationId, 201, response);
      return { ok: true, response };
    });
  }

  updateUnit(
    context: TenantTransactionContext,
    input: PreparedProductUnitUpdate,
  ): Promise<ProductMutationResult<ProductUnitMutationResponse>> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const operation: MutationOperation = {
        aggregateType: 'product_units',
        aggregateId: input.unitId,
        operationId: input.operationId,
        requestHash: input.requestHash,
        action: 'update',
        expectedVersion: input.expectedVersion,
      };
      const begun = await this.beginMutation(
        transaction,
        context,
        operation,
        parseStoredProductUnitMutationResponse,
      );
      if (begun) {
        return begun;
      }

      const currentRows = await transaction
        .select({ ...unitSelection, productId: productUnits.productId })
        .from(productUnits)
        .where(and(eq(productUnits.storeId, context.storeId), eq(productUnits.id, input.unitId)))
        .limit(1)
        .for('update');
      const current = currentRows[0];
      const stateConflict = this.classifyUnitState(current, input.expectedVersion);
      if (stateConflict) {
        await this.rejectOperation(transaction, context.storeId, input.operationId, stateConflict);
        return stateConflict;
      }
      const currentUnit = current as ProductUnitRow & { productId: string };

      let unit: ProductUnitRow;
      if (this.isUnitNoOp(currentUnit, input)) {
        unit = currentUnit;
      } else {
        const updates = this.buildUnitUpdates(context, input);
        let rows: ProductUnitRow[];
        try {
          rows = await transaction.transaction((savepoint) =>
            savepoint
              .update(productUnits)
              .set(updates)
              .where(
                and(
                  eq(productUnits.storeId, context.storeId),
                  eq(productUnits.id, input.unitId),
                  eq(productUnits.status, 'active'),
                  eq(productUnits.version, input.expectedVersion),
                ),
              )
              .returning(unitSelection),
          );
        } catch (error) {
          const conflict = this.classifyUnitConstraint(error);
          if (!conflict) {
            throw error;
          }
          await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
          return conflict;
        }
        const updated = rows[0];
        if (!updated) {
          throw new Error('Locked Product Unit update did not return a row.');
        }
        unit = updated;
      }

      const response = mapProductUnitMutationResponse(
        unit,
        currentUnit.productId,
        input.operationId,
      );
      await this.applyOperation(transaction, context.storeId, input.operationId, 200, response);
      return { ok: true, response };
    });
  }

  changeProductLifecycle(
    context: TenantTransactionContext,
    input: PreparedProductLifecycle,
  ): Promise<ProductMutationResult<ProductMutationResponse>> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const operation: MutationOperation = {
        aggregateType: 'products',
        aggregateId: input.productId,
        operationId: input.operationId,
        requestHash: input.requestHash,
        action: input.action,
        expectedVersion: input.expectedVersion,
      };
      const begun = await this.beginMutation(
        transaction,
        context,
        operation,
        parseStoredProductMutationResponse,
      );
      if (begun) {
        return begun;
      }

      const currentRows = await transaction
        .select(productSelection)
        .from(products)
        .where(and(eq(products.storeId, context.storeId), eq(products.id, input.productId)))
        .limit(1)
        .for('update');
      const current = currentRows[0];
      if (!current) {
        const conflict = failure('PRODUCT_NOT_FOUND');
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }
      if (current.version !== input.expectedVersion) {
        const conflict = failure('PRODUCT_VERSION_CONFLICT');
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }

      const targetStatus = input.action === 'archive' ? 'archived' : 'active';
      let product: ProductDetailRow = current;
      if (current.status !== targetStatus) {
        const rows = await transaction
          .update(products)
          .set({
            status: targetStatus,
            archivedAt: input.action === 'archive' ? sql`clock_timestamp()` : null,
            deviceId: context.deviceId,
            operationId: input.operationId,
          })
          .where(
            and(
              eq(products.storeId, context.storeId),
              eq(products.id, input.productId),
              eq(products.status, current.status),
              eq(products.version, input.expectedVersion),
            ),
          )
          .returning(productSelection);
        const updated = rows[0];
        if (!updated) {
          throw new Error('Locked Product lifecycle update did not return a row.');
        }
        product = updated;
      }

      const units = await this.loadUnits(transaction, context, input.productId);
      const response = mapProductMutationResponse(product, units, input.operationId);
      await this.applyOperation(transaction, context.storeId, input.operationId, 200, response);
      return { ok: true, response };
    });
  }

  changeUnitLifecycle(
    context: TenantTransactionContext,
    input: PreparedProductUnitLifecycle,
  ): Promise<ProductMutationResult<ProductUnitMutationResponse>> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const operation: MutationOperation = {
        aggregateType: 'product_units',
        aggregateId: input.unitId,
        operationId: input.operationId,
        requestHash: input.requestHash,
        action: input.action,
        expectedVersion: input.expectedVersion,
      };
      const begun = await this.beginMutation(
        transaction,
        context,
        operation,
        parseStoredProductUnitMutationResponse,
      );
      if (begun) {
        return begun;
      }

      const identityRows = await transaction
        .select({ productId: productUnits.productId })
        .from(productUnits)
        .where(and(eq(productUnits.storeId, context.storeId), eq(productUnits.id, input.unitId)))
        .limit(1);
      const identity = identityRows[0];
      if (!identity) {
        const conflict = failure('PRODUCT_UNIT_NOT_FOUND');
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }

      const productRows = await transaction
        .select({ id: products.id, status: products.status })
        .from(products)
        .where(and(eq(products.storeId, context.storeId), eq(products.id, identity.productId)))
        .limit(1)
        .for('update');
      const product = productRows[0];
      if (!product) {
        const conflict = failure('PRODUCT_UNIT_NOT_FOUND');
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }

      const currentRows = await transaction
        .select({ ...unitSelection, productId: productUnits.productId })
        .from(productUnits)
        .where(and(eq(productUnits.storeId, context.storeId), eq(productUnits.id, input.unitId)))
        .limit(1)
        .for('update');
      const current = currentRows[0];
      if (current?.productId !== product.id) {
        const conflict = failure('PRODUCT_UNIT_NOT_FOUND');
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }
      if (current.version !== input.expectedVersion) {
        const conflict = failure('PRODUCT_UNIT_VERSION_CONFLICT');
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }

      // P55-D3 and C1: parent eligibility precedes semantic no-op classification.
      if (input.action === 'restore' && product.status !== 'active') {
        const conflict = failure('CONFLICT');
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }

      const targetStatus = input.action === 'archive' ? 'archived' : 'active';
      const structuralConflict = await this.classifyUnitLifecycleStructure(
        transaction,
        context,
        current,
        input.action,
      );
      if (structuralConflict) {
        await this.rejectOperation(
          transaction,
          context.storeId,
          input.operationId,
          structuralConflict,
        );
        return structuralConflict;
      }

      if (current.status === targetStatus) {
        const response = mapProductUnitMutationResponse(
          current,
          current.productId,
          input.operationId,
        );
        await this.applyOperation(transaction, context.storeId, input.operationId, 200, response);
        return { ok: true, response };
      }

      let rows: ProductUnitRow[];
      try {
        rows = await transaction.transaction((savepoint) =>
          savepoint
            .update(productUnits)
            .set({
              status: targetStatus,
              deviceId: context.deviceId,
              operationId: input.operationId,
            })
            .where(
              and(
                eq(productUnits.storeId, context.storeId),
                eq(productUnits.id, input.unitId),
                eq(productUnits.status, current.status),
                eq(productUnits.version, input.expectedVersion),
              ),
            )
            .returning(unitSelection),
        );
      } catch (error) {
        const conflict = this.classifyUnitConstraint(error);
        if (!conflict) {
          throw error;
        }
        await this.rejectOperation(transaction, context.storeId, input.operationId, conflict);
        return conflict;
      }
      const unit = rows[0];
      if (!unit) {
        throw new Error('Locked Product Unit lifecycle update did not return a row.');
      }

      const response = mapProductUnitMutationResponse(unit, current.productId, input.operationId);
      await this.applyOperation(transaction, context.storeId, input.operationId, 200, response);
      return { ok: true, response };
    });
  }

  private async classifyUnitLifecycleStructure(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    current: ProductUnitRow & { productId: string },
    action: 'archive' | 'restore',
  ): Promise<FailureResult | null> {
    if (action === 'archive') {
      if (!current.isBase) {
        return null;
      }
      const activeConversions = await transaction
        .select({ id: productUnits.id })
        .from(productUnits)
        .where(
          and(
            eq(productUnits.storeId, context.storeId),
            eq(productUnits.productId, current.productId),
            eq(productUnits.isBase, false),
            eq(productUnits.status, 'active'),
          ),
        )
        .orderBy(productUnits.id)
        .for('update');
      return activeConversions.length > 0 ? failure('CONFLICT') : null;
    }

    if (current.isBase) {
      const activeBases = await transaction
        .select({ id: productUnits.id })
        .from(productUnits)
        .where(
          and(
            eq(productUnits.storeId, context.storeId),
            eq(productUnits.productId, current.productId),
            eq(productUnits.isBase, true),
            eq(productUnits.status, 'active'),
            ne(productUnits.id, current.id),
          ),
        )
        .orderBy(productUnits.id)
        .for('update');
      return activeBases.length > 0 ? failure('CONFLICT') : null;
    }

    const activeBases = await transaction
      .select({ id: productUnits.id })
      .from(productUnits)
      .where(
        and(
          eq(productUnits.storeId, context.storeId),
          eq(productUnits.productId, current.productId),
          eq(productUnits.isBase, true),
          eq(productUnits.status, 'active'),
        ),
      )
      .orderBy(productUnits.id)
      .for('update');
    return activeBases.length > 0 ? null : failure('PRODUCT_BASE_UNIT_REQUIRED');
  }

  private async beginMutation<T>(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
    parse: (body: unknown) => T,
  ): Promise<ProductMutationResult<T> | null> {
    const prior = await this.readProcessedOperation(
      transaction,
      context.storeId,
      operation.operationId,
    );
    if (prior) {
      return this.resolveProcessedOperation(transaction, context, operation, prior, parse);
    }

    // P54-D10: the new-business-write gate applies only to a NEW operation, after the
    // completed-replay lookup above.
    await this.assertActiveStoreForNewWrite(transaction, context);

    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${operation.operationId}::uuid,
            ${context.deviceId}::uuid,
            ${operation.aggregateType},
            ${operation.aggregateId}::uuid,
            ${operation.action},
            ${operation.requestHash}
          ) as claimed
        `),
      );
      claimed = result.rows[0]?.claimed === true;
    } catch (error) {
      if (uniqueConstraint(error) === undefined) {
        throw error;
      }
      const concurrent = await this.readProcessedOperation(
        transaction,
        context.storeId,
        operation.operationId,
      );
      if (!concurrent) {
        throw error;
      }
      return this.resolveProcessedOperation(transaction, context, operation, concurrent, parse);
    }

    if (claimed) {
      return null;
    }

    const existing = await this.readProcessedOperation(
      transaction,
      context.storeId,
      operation.operationId,
    );
    if (!existing) {
      throw new Error('Claimed Product operation could not be read.');
    }
    return this.resolveProcessedOperation(transaction, context, operation, existing, parse);
  }

  private async assertActiveStoreForNewWrite(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
  ): Promise<void> {
    const rows = await transaction
      .select({ status: stores.status })
      .from(stores)
      .where(eq(stores.id, context.storeId))
      .limit(1)
      .for('share');
    if (rows[0]?.status !== 'active') {
      throw new ForbiddenException({
        code: 'BUSINESS_WRITE_NOT_ALLOWED',
        message: 'Business writes are not allowed.',
      });
    }
  }

  private async readProcessedOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperationRow | undefined> {
    const result = await transaction.execute<ProcessedOperationRow>(sql`
      select
        device_id as "deviceId",
        aggregate_type as "aggregateType",
        aggregate_id as "aggregateId",
        action,
        request_hash as "requestHash",
        status,
        response_code as "responseCode",
        response_body as "responseBody",
        error_code as "errorCode"
      from sync.processed_operations
      where store_id = ${storeId}::uuid
        and operation_id = ${operationId}::uuid
    `);
    return result.rows[0];
  }

  private async resolveProcessedOperation<T>(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
    existing: ProcessedOperationRow,
    parse: (body: unknown) => T,
  ): Promise<ProductMutationResult<T>> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== operation.aggregateType ||
      existing.aggregateId !== operation.aggregateId ||
      existing.action !== operation.action ||
      existing.requestHash !== operation.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, operation);
      return failure('OPERATION_ID_CONFLICT');
    }

    if (existing.status === 'applied') {
      return { ok: true, response: parse(existing.responseBody) };
    }
    if (existing.status === 'rejected') {
      const code = existing.errorCode;
      if (!code || !(code in failureDefinitions)) {
        throw new Error('Stored Product mutation rejection is invalid.');
      }
      return failure(code as ProductMutationFailureCode);
    }
    return failure('OPERATION_IN_PROGRESS');
  }

  private async loadUnits(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    productId: string,
  ): Promise<ProductUnitRow[]> {
    return transaction
      .select(unitSelection)
      .from(productUnits)
      .where(and(eq(productUnits.storeId, context.storeId), eq(productUnits.productId, productId)))
      .orderBy(
        sql`${productUnits.isBase} desc, ${productUnits.unitName} asc, ${productUnits.id} asc`,
      );
  }

  private classifyProductState(
    current: ProductDetailRow | undefined,
    expectedVersion: bigint,
  ): FailureResult | null {
    if (!current) {
      return failure('PRODUCT_NOT_FOUND');
    }
    if (current.status === 'archived') {
      return failure('PRODUCT_ARCHIVED');
    }
    if (current.version !== expectedVersion) {
      return failure('PRODUCT_VERSION_CONFLICT');
    }
    return null;
  }

  private classifyUnitState(
    current: (ProductUnitRow & { productId: string }) | undefined,
    expectedVersion: bigint,
  ): FailureResult | null {
    if (!current) {
      return failure('PRODUCT_UNIT_NOT_FOUND');
    }
    if (current.status === 'archived') {
      return failure('PRODUCT_UNIT_ARCHIVED');
    }
    if (current.version !== expectedVersion) {
      return failure('PRODUCT_UNIT_VERSION_CONFLICT');
    }
    return null;
  }

  private isProductNoOp(current: ProductDetailRow, input: PreparedProductUpdate): boolean {
    if (input.name !== undefined && input.name !== current.name) {
      return false;
    }
    if (input.sku !== undefined && input.sku !== current.sku) {
      return false;
    }
    if (input.barcode !== undefined && input.barcode !== current.barcode) {
      return false;
    }
    if (input.description !== undefined && input.description !== current.description) {
      return false;
    }
    if (input.isPinned !== undefined && input.isPinned !== current.isPinned) {
      return false;
    }
    if (
      input.lowStockThresholdMilli !== undefined &&
      input.lowStockThresholdMilli !== current.lowStockThresholdMilli
    ) {
      return false;
    }
    if (
      input.allowNegativeStockOverride !== undefined &&
      input.allowNegativeStockOverride !== current.allowNegativeStockOverride
    ) {
      return false;
    }
    return true;
  }

  private isUnitNoOp(current: ProductUnitRow, input: PreparedProductUnitUpdate): boolean {
    if (input.unitName !== undefined && input.unitName !== current.unitName) {
      return false;
    }
    if (input.unitCode !== undefined && input.unitCode !== current.unitCode) {
      return false;
    }
    if (input.salePriceMinor !== undefined && input.salePriceMinor !== current.salePriceMinor) {
      return false;
    }
    if (
      input.purchasePriceMinor !== undefined &&
      input.purchasePriceMinor !== current.purchasePriceMinor
    ) {
      return false;
    }
    return true;
  }

  private buildProductUpdates(
    context: TenantTransactionContext,
    input: PreparedProductUpdate,
  ): Record<string, unknown> {
    const updates: Record<string, unknown> = {
      deviceId: context.deviceId,
      operationId: input.operationId,
    };
    if (input.name !== undefined && input.normalizedName !== undefined) {
      updates.name = input.name;
      updates.normalizedName = input.normalizedName;
    }
    if (input.sku !== undefined) {
      updates.sku = input.sku;
    }
    if (input.barcode !== undefined) {
      updates.barcode = input.barcode;
    }
    if (input.description !== undefined) {
      updates.description = input.description;
    }
    if (input.isPinned !== undefined) {
      updates.isPinned = input.isPinned;
    }
    if (input.lowStockThresholdMilli !== undefined) {
      updates.lowStockThresholdMilli = input.lowStockThresholdMilli;
    }
    if (input.allowNegativeStockOverride !== undefined) {
      updates.allowNegativeStockOverride = input.allowNegativeStockOverride;
    }
    return updates;
  }

  private buildUnitUpdates(
    context: TenantTransactionContext,
    input: PreparedProductUnitUpdate,
  ): Record<string, unknown> {
    const updates: Record<string, unknown> = {
      deviceId: context.deviceId,
      operationId: input.operationId,
    };
    if (input.unitName !== undefined) {
      updates.unitName = input.unitName;
    }
    if (input.unitCode !== undefined) {
      updates.unitCode = input.unitCode;
    }
    if (input.salePriceMinor !== undefined) {
      updates.salePriceMinor = input.salePriceMinor;
    }
    if (input.purchasePriceMinor !== undefined) {
      updates.purchasePriceMinor = input.purchasePriceMinor;
    }
    return updates;
  }

  private async classifyCreateFailure(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedProductCreate,
    error: unknown,
  ): Promise<FailureResult | null> {
    if (error instanceof NestedConflict) {
      if (error.which === 'product') {
        return this.classifyProductCreateConflict(transaction, context, input);
      }
      return this.classifyBaseUnitCreateConflict(transaction, context, input);
    }
    return this.classifyProductConstraint(error);
  }

  private async classifyProductCreateConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedProductCreate,
  ): Promise<FailureResult> {
    const existing = await transaction
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.storeId, context.storeId), eq(products.id, input.productId)))
      .limit(1);
    if (existing[0]) {
      return failure('CONFLICT');
    }
    const sameOperation = await transaction
      .select({ id: products.id })
      .from(products)
      .where(
        and(eq(products.storeId, context.storeId), eq(products.operationId, input.operationId)),
      )
      .limit(1);
    if (sameOperation[0]) {
      return failure('OPERATION_ID_CONFLICT');
    }
    if (input.sku !== null) {
      const sameSku = await transaction
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.storeId, context.storeId), eq(products.sku, input.sku)))
        .limit(1);
      if (sameSku[0]) {
        return failure('PRODUCT_SKU_CONFLICT');
      }
    }
    if (input.barcode !== null) {
      const sameBarcode = await transaction
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.storeId, context.storeId), eq(products.barcode, input.barcode)))
        .limit(1);
      if (sameBarcode[0]) {
        return failure('PRODUCT_BARCODE_CONFLICT');
      }
    }
    return failure('CONFLICT');
  }

  private async classifyBaseUnitCreateConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedProductCreate,
  ): Promise<FailureResult> {
    const sameId = await transaction
      .select({ id: productUnits.id })
      .from(productUnits)
      .where(
        and(eq(productUnits.storeId, context.storeId), eq(productUnits.id, input.baseUnit.unitId)),
      )
      .limit(1);
    if (sameId[0]) {
      return failure('CONFLICT');
    }
    const sameOperation = await transaction
      .select({ id: productUnits.id })
      .from(productUnits)
      .where(
        and(
          eq(productUnits.storeId, context.storeId),
          eq(productUnits.operationId, input.operationId),
        ),
      )
      .limit(1);
    if (sameOperation[0]) {
      return failure('OPERATION_ID_CONFLICT');
    }
    return failure('CONFLICT');
  }

  private async classifyUnitCreateConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedProductUnitCreate,
  ): Promise<FailureResult> {
    const sameId = await transaction
      .select({ id: productUnits.id })
      .from(productUnits)
      .where(and(eq(productUnits.storeId, context.storeId), eq(productUnits.id, input.unitId)))
      .limit(1);
    if (sameId[0]) {
      return failure('CONFLICT');
    }
    const sameOperation = await transaction
      .select({ id: productUnits.id })
      .from(productUnits)
      .where(
        and(
          eq(productUnits.storeId, context.storeId),
          eq(productUnits.operationId, input.operationId),
        ),
      )
      .limit(1);
    if (sameOperation[0]) {
      return failure('OPERATION_ID_CONFLICT');
    }
    const sameName = await transaction
      .select({ id: productUnits.id })
      .from(productUnits)
      .where(
        and(
          eq(productUnits.storeId, context.storeId),
          eq(productUnits.productId, input.productId),
          eq(productUnits.unitName, input.unitName),
        ),
      )
      .limit(1);
    if (sameName[0]) {
      return failure('PRODUCT_UNIT_NAME_CONFLICT');
    }
    return failure('CONFLICT');
  }

  private classifyProductConstraint(error: unknown): FailureResult | null {
    const constraint = uniqueConstraint(error);
    if (constraint === undefined) {
      return null;
    }
    if (constraint === 'products_store_id_sku_key') {
      return failure('PRODUCT_SKU_CONFLICT');
    }
    if (constraint === 'products_store_id_barcode_key') {
      return failure('PRODUCT_BARCODE_CONFLICT');
    }
    if (constraint === 'products_store_id_operation_id_key') {
      return failure('OPERATION_ID_CONFLICT');
    }
    return failure('CONFLICT');
  }

  private classifyUnitConstraint(error: unknown): FailureResult | null {
    const constraint = uniqueConstraint(error);
    if (constraint === undefined) {
      return null;
    }
    if (constraint === 'product_units_store_id_product_id_unit_name_key') {
      return failure('PRODUCT_UNIT_NAME_CONFLICT');
    }
    if (constraint === 'product_units_store_id_operation_id_key') {
      return failure('OPERATION_ID_CONFLICT');
    }
    return failure('CONFLICT');
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    responseCode: number,
    response: unknown,
  ): Promise<void> {
    const result = await transaction.execute(sql`
      update sync.processed_operations
      set
        status = 'applied',
        response_code = ${responseCode},
        response_body = ${JSON.stringify(response)}::jsonb,
        error_code = null,
        completed_at = clock_timestamp()
      where store_id = ${storeId}::uuid
        and operation_id = ${operationId}::uuid
        and status = 'processing'
      returning operation_id
    `);
    if (result.rows.length !== 1) {
      throw new Error('Product operation completion failed.');
    }
  }

  private async rejectOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    result: ProductMutationResult<unknown>,
  ): Promise<void> {
    if (result.ok) {
      throw new TypeError('A successful Product mutation cannot be rejected.');
    }
    const response = { code: result.error.code, message: result.error.message };
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set
        status = 'rejected',
        response_code = ${result.error.statusCode},
        response_body = ${JSON.stringify(response)}::jsonb,
        error_code = ${result.error.code},
        completed_at = clock_timestamp()
      where store_id = ${storeId}::uuid
        and operation_id = ${operationId}::uuid
        and status = 'processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) {
      throw new Error('Product operation rejection failed.');
    }
  }

  private async recordOperationConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
  ): Promise<void> {
    await transaction.execute(sql`
      insert into sync.conflicts (
        store_id,
        operation_id,
        entity_type,
        entity_id,
        client_version,
        conflict_type,
        client_payload
      ) values (
        ${context.storeId}::uuid,
        ${operation.operationId}::uuid,
        ${operation.aggregateType},
        ${operation.aggregateId}::uuid,
        ${operation.expectedVersion?.toString() ?? null}::bigint,
        'duplicate_identity',
        jsonb_build_object(
          'action',
          ${operation.action}::text,
          'requestHash',
          ${operation.requestHash}::text
        )
      )
    `);
  }
}
