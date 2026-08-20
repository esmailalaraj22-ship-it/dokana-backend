import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { ProductWriteRepository } from './product-write.repository';
import {
  canonicalizeProductBarcode,
  canonicalizeProductDescription,
  canonicalizeProductName,
  canonicalizeProductSku,
  canonicalizeProductUnitCode,
  canonicalizeProductUnitName,
  canonicalizeProductUuid,
  POSTGRESQL_BIGINT_MAX,
  ProductValidationError,
  validateProductLowStockThresholdMilli,
  validateProductMeasurementType,
  validateProductNegativeStockOverride,
  validateProductPinned,
  validateProductTrackInventory,
  validateProductUnitPurchasePriceMinor,
  validateProductUnitRatio,
  validateProductUnitSalePriceMinor,
} from './product-validation';
import type {
  ProductMutationFailure,
  ProductMutationResponse,
  ProductMutationResult,
  ProductUnitMutationResponse,
  PreparedProductCreate,
  PreparedProductUnitCreate,
  PreparedProductUnitUpdate,
  PreparedProductUpdate,
} from './product-write.types';
import type { CreateProductDto } from './dto/create-product.dto';
import type { CreateProductUnitDto } from './dto/create-product-unit.dto';
import type { UpdateProductDto } from './dto/update-product.dto';
import type { UpdateProductUnitDto } from './dto/update-product-unit.dto';

export const PRODUCT_WRITE_REQUEST_VERSION = 1;

type ProductWritePrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class ProductWriteService {
  constructor(private readonly repository: ProductWriteRepository) {}

  async create(
    principal: ProductWritePrincipal,
    context: TenantTransactionContext,
    dto: CreateProductDto,
  ): Promise<ProductMutationResponse> {
    this.assertAuthorized(principal, context);
    let input: PreparedProductCreate;
    try {
      const productId = canonicalizeProductUuid(dto.id, 'id');
      const operationId = canonicalizeProductUuid(dto.operationId, 'operationId');
      const { name, normalizedName } = canonicalizeProductName(dto.name);
      const sku = canonicalizeProductSku(dto.sku ?? null);
      const barcode = canonicalizeProductBarcode(dto.barcode ?? null);
      const description = canonicalizeProductDescription(dto.description ?? null);
      const measurementType = validateProductMeasurementType(dto.measurementType);
      const trackInventory = validateProductTrackInventory(dto.trackInventory);
      const allowNegativeStockOverride = validateProductNegativeStockOverride(
        dto.allowNegativeStockOverride ?? null,
      );
      const lowStockThresholdMilli = validateProductLowStockThresholdMilli(
        this.toNonNegativeBigint(dto.lowStockThresholdMilli) ?? null,
      );
      const isPinned = validateProductPinned(dto.isPinned ?? false);

      const unitId = canonicalizeProductUuid(dto.initialBaseUnit.id, 'productId');
      const unitName = canonicalizeProductUnitName(dto.initialBaseUnit.unitName);
      const unitCode = canonicalizeProductUnitCode(dto.initialBaseUnit.unitCode ?? null);
      const salePriceMinor = validateProductUnitSalePriceMinor(
        this.toNonNegativeBigint(dto.initialBaseUnit.salePriceMinor) ?? null,
      );
      const purchasePriceMinor = validateProductUnitPurchasePriceMinor(
        this.toNonNegativeBigint(dto.initialBaseUnit.purchasePriceMinor) ?? null,
      );

      input = {
        productId,
        operationId,
        name,
        normalizedName,
        sku,
        barcode,
        description,
        measurementType,
        trackInventory,
        allowNegativeStockOverride,
        lowStockThresholdMilli,
        isPinned,
        baseUnit: { unitId, unitName, unitCode, salePriceMinor, purchasePriceMinor },
        requestHash: this.hashRequest({
          v: PRODUCT_WRITE_REQUEST_VERSION,
          action: 'product.create',
          productId,
          name,
          normalizedName,
          sku,
          barcode,
          description,
          measurementType,
          trackInventory,
          allowNegativeStockOverride,
          lowStockThresholdMilli: lowStockThresholdMilli?.toString() ?? null,
          isPinned,
          baseUnit: {
            unitId,
            unitName,
            unitCode,
            salePriceMinor: salePriceMinor?.toString() ?? null,
            purchasePriceMinor: purchasePriceMinor?.toString() ?? null,
          },
        }),
      };
    } catch (error) {
      this.rethrowValidationError(error);
    }

    return this.unwrap(await this.repository.createProduct(context, input));
  }

  async update(
    principal: ProductWritePrincipal,
    context: TenantTransactionContext,
    productId: string,
    dto: UpdateProductDto,
  ): Promise<ProductMutationResponse> {
    this.assertAuthorized(principal, context);
    if (
      dto.name === undefined &&
      dto.sku === undefined &&
      dto.barcode === undefined &&
      dto.description === undefined &&
      dto.isPinned === undefined &&
      dto.lowStockThresholdMilli === undefined &&
      dto.allowNegativeStockOverride === undefined
    ) {
      throw this.validationException('body', 'productMutableField');
    }

    const expectedVersion = this.parseExpectedVersion(dto.expectedVersion);
    const canonicalProductId = canonicalizeProductUuid(productId, 'productId');
    const operationId = canonicalizeProductUuid(dto.operationId, 'operationId');

    let input: PreparedProductUpdate;
    try {
      const canonicalName = dto.name === undefined ? undefined : canonicalizeProductName(dto.name);
      const name = canonicalName?.name;
      const normalizedName = canonicalName?.normalizedName;
      const sku = dto.sku === undefined ? undefined : canonicalizeProductSku(dto.sku);
      const barcode =
        dto.barcode === undefined ? undefined : canonicalizeProductBarcode(dto.barcode);
      const description =
        dto.description === undefined ? undefined : canonicalizeProductDescription(dto.description);
      const isPinned = dto.isPinned === undefined ? undefined : validateProductPinned(dto.isPinned);
      const lowStockThresholdMilli =
        dto.lowStockThresholdMilli === undefined
          ? undefined
          : validateProductLowStockThresholdMilli(
              this.toNonNegativeBigint(dto.lowStockThresholdMilli),
            );
      const allowNegativeStockOverride =
        dto.allowNegativeStockOverride === undefined
          ? undefined
          : validateProductNegativeStockOverride(dto.allowNegativeStockOverride);

      const payload: Record<string, unknown> = {
        v: PRODUCT_WRITE_REQUEST_VERSION,
        action: 'product.update',
        productId: canonicalProductId,
        operationId,
        expectedVersion: expectedVersion.toString(),
      };
      if (name !== undefined && normalizedName !== undefined) {
        payload.name = name;
        payload.normalizedName = normalizedName;
      }
      if (sku !== undefined) {
        payload.sku = sku;
      }
      if (barcode !== undefined) {
        payload.barcode = barcode;
      }
      if (description !== undefined) {
        payload.description = description;
      }
      if (isPinned !== undefined) {
        payload.isPinned = isPinned;
      }
      if (lowStockThresholdMilli !== undefined) {
        payload.lowStockThresholdMilli = lowStockThresholdMilli?.toString() ?? null;
      }
      if (allowNegativeStockOverride !== undefined) {
        payload.allowNegativeStockOverride = allowNegativeStockOverride;
      }

      input = {
        productId: canonicalProductId,
        operationId,
        expectedVersion,
        name,
        normalizedName,
        sku,
        barcode,
        description,
        isPinned,
        lowStockThresholdMilli,
        allowNegativeStockOverride,
        requestHash: this.hashRequest(payload),
      };
    } catch (error) {
      this.rethrowValidationError(error);
    }

    return this.unwrap(await this.repository.updateProduct(context, input));
  }

  async createUnit(
    principal: ProductWritePrincipal,
    context: TenantTransactionContext,
    dto: CreateProductUnitDto,
  ): Promise<ProductUnitMutationResponse> {
    this.assertAuthorized(principal, context);
    let input: PreparedProductUnitCreate;
    try {
      const unitId = canonicalizeProductUuid(dto.id, 'id');
      const operationId = canonicalizeProductUuid(dto.operationId, 'operationId');
      const productId = canonicalizeProductUuid(dto.productId, 'productId');
      const unitName = canonicalizeProductUnitName(dto.unitName);
      const unitCode = canonicalizeProductUnitCode(dto.unitCode ?? null);
      const ratio = validateProductUnitRatio({
        isBase: false,
        factorNum: dto.factorNum,
        factorDen: dto.factorDen,
      });
      const salePriceMinor = validateProductUnitSalePriceMinor(
        this.toNonNegativeBigint(dto.salePriceMinor) ?? null,
      );
      const purchasePriceMinor = validateProductUnitPurchasePriceMinor(
        this.toNonNegativeBigint(dto.purchasePriceMinor) ?? null,
      );

      input = {
        unitId,
        operationId,
        productId,
        unitName,
        unitCode,
        factorNum: ratio.factorNum,
        factorDen: ratio.factorDen,
        salePriceMinor,
        purchasePriceMinor,
        requestHash: this.hashRequest({
          v: PRODUCT_WRITE_REQUEST_VERSION,
          action: 'product_unit.create',
          unitId,
          productId,
          unitName,
          unitCode,
          factorNum: ratio.factorNum,
          factorDen: ratio.factorDen,
          salePriceMinor: salePriceMinor?.toString() ?? null,
          purchasePriceMinor: purchasePriceMinor?.toString() ?? null,
        }),
      };
    } catch (error) {
      this.rethrowValidationError(error);
    }

    return this.unwrapUnit(await this.repository.createUnit(context, input));
  }

  async updateUnit(
    principal: ProductWritePrincipal,
    context: TenantTransactionContext,
    unitId: string,
    dto: UpdateProductUnitDto,
  ): Promise<ProductUnitMutationResponse> {
    this.assertAuthorized(principal, context);
    if (
      dto.unitName === undefined &&
      dto.unitCode === undefined &&
      dto.salePriceMinor === undefined &&
      dto.purchasePriceMinor === undefined
    ) {
      throw this.validationException('body', 'productUnitMutableField');
    }

    const expectedVersion = this.parseExpectedVersion(dto.expectedVersion);
    const canonicalUnitId = canonicalizeProductUuid(unitId, 'id');
    const operationId = canonicalizeProductUuid(dto.operationId, 'operationId');

    let input: PreparedProductUnitUpdate;
    try {
      const unitName =
        dto.unitName === undefined ? undefined : canonicalizeProductUnitName(dto.unitName);
      const unitCode =
        dto.unitCode === undefined ? undefined : canonicalizeProductUnitCode(dto.unitCode);
      const salePriceMinor =
        dto.salePriceMinor === undefined
          ? undefined
          : validateProductUnitSalePriceMinor(this.toNonNegativeBigint(dto.salePriceMinor));
      const purchasePriceMinor =
        dto.purchasePriceMinor === undefined
          ? undefined
          : validateProductUnitPurchasePriceMinor(this.toNonNegativeBigint(dto.purchasePriceMinor));

      const payload: Record<string, unknown> = {
        v: PRODUCT_WRITE_REQUEST_VERSION,
        action: 'product_unit.update',
        unitId: canonicalUnitId,
        operationId,
        expectedVersion: expectedVersion.toString(),
      };
      if (unitName !== undefined) {
        payload.unitName = unitName;
      }
      if (unitCode !== undefined) {
        payload.unitCode = unitCode;
      }
      if (salePriceMinor !== undefined) {
        payload.salePriceMinor = salePriceMinor?.toString() ?? null;
      }
      if (purchasePriceMinor !== undefined) {
        payload.purchasePriceMinor = purchasePriceMinor?.toString() ?? null;
      }

      input = {
        unitId: canonicalUnitId,
        operationId,
        expectedVersion,
        unitName,
        unitCode,
        salePriceMinor,
        purchasePriceMinor,
        requestHash: this.hashRequest(payload),
      };
    } catch (error) {
      this.rethrowValidationError(error);
    }

    return this.unwrapUnit(await this.repository.updateUnit(context, input));
  }

  private assertAuthorized(
    principal: ProductWritePrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'PRODUCT_WRITE_NOT_ALLOWED',
        message: 'Product writes are not allowed.',
      });
    }
  }

  private toNonNegativeBigint(value: string | null | undefined): bigint | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    return BigInt(value);
  }

  private parseExpectedVersion(value: string): bigint {
    const expectedVersion = BigInt(value);
    if (expectedVersion > POSTGRESQL_BIGINT_MAX) {
      throw this.validationException('expectedVersion', 'maxPostgreSqlBigint');
    }
    return expectedVersion;
  }

  private hashRequest(payload: object): string {
    return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  }

  private unwrap(result: ProductMutationResult<ProductMutationResponse>): ProductMutationResponse {
    if (result.ok) {
      return result.response;
    }
    this.throwMutationFailure(result.error);
  }

  private unwrapUnit(
    result: ProductMutationResult<ProductUnitMutationResponse>,
  ): ProductUnitMutationResponse {
    if (result.ok) {
      return result.response;
    }
    this.throwMutationFailure(result.error);
  }

  private throwMutationFailure(error: ProductMutationFailure): never {
    const payload = { code: error.code, message: error.message };
    if (error.statusCode === 404) {
      throw new NotFoundException(payload);
    }
    throw new ConflictException(payload);
  }

  private rethrowValidationError(error: unknown): never {
    if (error instanceof ProductValidationError) {
      throw this.validationException(error.field, error.code);
    }
    throw error;
  }

  private validationException(field: string, constraint: string): BadRequestException {
    return new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: [{ field, constraints: [constraint] }],
    });
  }
}
