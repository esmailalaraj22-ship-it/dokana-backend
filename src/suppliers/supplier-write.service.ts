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
import type { CreateSupplierDto } from './dto/create-supplier.dto';
import type { SupplierLifecycleDto } from './dto/supplier-lifecycle.dto';
import type { UpdateSupplierDto } from './dto/update-supplier.dto';
import {
  canonicalizeSupplierName,
  canonicalizeSupplierNotes,
  canonicalizeSupplierPhone,
  canonicalizeSupplierUuid,
  SupplierValidationError,
} from './supplier-validation';
import { SupplierWriteRepository } from './supplier-write.repository';
import type {
  PreparedSupplierCreate,
  PreparedSupplierLifecycle,
  PreparedSupplierUpdate,
  SupplierLifecycleAction,
  SupplierMutationFailure,
  SupplierMutationResponse,
  SupplierMutationResult,
} from './supplier-write.types';

const maximumPostgreSqlBigint = 9_223_372_036_854_775_807n;
export const SUPPLIER_WRITE_REQUEST_VERSION = 1;

type SupplierWritePrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SupplierWriteService {
  constructor(private readonly repository: SupplierWriteRepository) {}

  async create(
    principal: SupplierWritePrincipal,
    context: TenantTransactionContext,
    dto: CreateSupplierDto,
  ): Promise<SupplierMutationResponse> {
    this.assertAuthorized(principal, context);

    let input: PreparedSupplierCreate;
    try {
      const supplierId = canonicalizeSupplierUuid(dto.id, 'id');
      const operationId = canonicalizeSupplierUuid(dto.operationId, 'operationId');
      const { name, normalizedName } = canonicalizeSupplierName(dto.name);
      const { phone, normalizedPhone } = canonicalizeSupplierPhone(dto.phone);
      const notes = dto.notes === undefined ? null : canonicalizeSupplierNotes(dto.notes);
      input = {
        supplierId,
        operationId,
        name,
        normalizedName,
        phone,
        normalizedPhone,
        notes,
        requestHash: this.hashRequest({
          v: SUPPLIER_WRITE_REQUEST_VERSION,
          action: 'supplier.create',
          supplierId,
          name,
          normalizedName,
          phone,
          normalizedPhone,
          notes,
        }),
      };
    } catch (error) {
      this.rethrowValidationError(error);
    }

    return this.unwrap(await this.repository.create(context, input));
  }

  async update(
    principal: SupplierWritePrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    dto: UpdateSupplierDto,
  ): Promise<SupplierMutationResponse> {
    this.assertAuthorized(principal, context);
    if (dto.name === undefined && dto.phone === undefined && dto.notes === undefined) {
      throw this.validationException('body', 'supplierMutableField');
    }

    const expectedVersion = this.parseExpectedVersion(dto.expectedVersion);
    let input: PreparedSupplierUpdate;
    try {
      const canonicalSupplierId = canonicalizeSupplierUuid(supplierId, 'id');
      const operationId = canonicalizeSupplierUuid(dto.operationId, 'operationId');
      const canonicalName = dto.name === undefined ? undefined : canonicalizeSupplierName(dto.name);
      const canonicalPhone =
        dto.phone === undefined ? undefined : canonicalizeSupplierPhone(dto.phone);
      const notes = dto.notes === undefined ? undefined : canonicalizeSupplierNotes(dto.notes);

      const canonicalRequest: Record<string, unknown> = {
        v: SUPPLIER_WRITE_REQUEST_VERSION,
        action: 'supplier.update',
        supplierId: canonicalSupplierId,
        expectedVersion: expectedVersion.toString(),
      };
      if (canonicalName) {
        canonicalRequest.name = canonicalName.name;
        canonicalRequest.normalizedName = canonicalName.normalizedName;
      }
      if (canonicalPhone) {
        canonicalRequest.phone = canonicalPhone.phone;
        canonicalRequest.normalizedPhone = canonicalPhone.normalizedPhone;
      }
      if (dto.notes !== undefined) {
        canonicalRequest.notes = notes;
      }

      input = {
        supplierId: canonicalSupplierId,
        operationId,
        expectedVersion,
        name: canonicalName?.name,
        normalizedName: canonicalName?.normalizedName,
        phone: canonicalPhone?.phone,
        normalizedPhone: canonicalPhone?.normalizedPhone,
        notes,
        requestHash: this.hashRequest(canonicalRequest),
      };
    } catch (error) {
      this.rethrowValidationError(error);
    }

    return this.unwrap(await this.repository.update(context, input));
  }

  archive(
    principal: SupplierWritePrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    dto: SupplierLifecycleDto,
  ): Promise<SupplierMutationResponse> {
    return this.changeLifecycle(principal, context, supplierId, dto, 'archive');
  }

  restore(
    principal: SupplierWritePrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    dto: SupplierLifecycleDto,
  ): Promise<SupplierMutationResponse> {
    return this.changeLifecycle(principal, context, supplierId, dto, 'restore');
  }

  private async changeLifecycle(
    principal: SupplierWritePrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    dto: SupplierLifecycleDto,
    action: SupplierLifecycleAction,
  ): Promise<SupplierMutationResponse> {
    this.assertAuthorized(principal, context);

    let input: PreparedSupplierLifecycle;
    try {
      const canonicalSupplierId = canonicalizeSupplierUuid(supplierId, 'id');
      const operationId = canonicalizeSupplierUuid(dto.operationId, 'operationId');
      const expectedVersion = this.parseExpectedVersion(dto.expectedVersion);
      input = {
        supplierId: canonicalSupplierId,
        operationId,
        expectedVersion,
        action,
        requestHash: this.hashRequest({
          v: SUPPLIER_WRITE_REQUEST_VERSION,
          action: `supplier.${action}`,
          supplierId: canonicalSupplierId,
          expectedVersion: expectedVersion.toString(),
        }),
      };
    } catch (error) {
      this.rethrowValidationError(error);
    }

    return this.unwrap(await this.repository.changeLifecycle(context, input));
  }

  private assertAuthorized(
    principal: SupplierWritePrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'SUPPLIER_WRITE_NOT_ALLOWED',
        message: 'Supplier writes are not allowed.',
      });
    }
  }

  private parseExpectedVersion(value: string): bigint {
    const expectedVersion = BigInt(value);
    if (expectedVersion > maximumPostgreSqlBigint) {
      throw this.validationException('expectedVersion', 'maxPostgreSqlBigint');
    }
    return expectedVersion;
  }

  private hashRequest(payload: object): string {
    return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  }

  private unwrap(result: SupplierMutationResult): SupplierMutationResponse {
    if (result.ok) {
      return result.response;
    }
    this.throwMutationFailure(result.error);
  }

  private throwMutationFailure(error: SupplierMutationFailure): never {
    const payload = { code: error.code, message: error.message };
    if (error.statusCode === 404) {
      throw new NotFoundException(payload);
    }
    throw new ConflictException(payload);
  }

  private rethrowValidationError(error: unknown): never {
    if (error instanceof SupplierValidationError) {
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
