import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { TenantTransactionContext } from '../database/database.types';
import {
  cleanCustomerDisplayName,
  cleanCustomerDisplayPhone,
  CUSTOMER_NORMALIZATION_VERSION,
  CustomerNormalizationError,
  normalizeCustomerName,
  normalizeCustomerPhone,
} from './customer-normalization';
import { CustomerWriteRepository } from './customer-write.repository';
import type {
  CustomerMutationFailure,
  CustomerMutationResponse,
  CustomerMutationResult,
  PreparedCustomerCreate,
  PreparedCustomerUpdate,
} from './customer-write.types';
import type { CreateCustomerDto } from './dto/create-customer.dto';
import type { UpdateCustomerDto } from './dto/update-customer.dto';

const maximumPostgreSqlBigint = 9_223_372_036_854_775_807n;

@Injectable()
export class CustomerWriteService {
  constructor(private readonly repository: CustomerWriteRepository) {}

  async create(
    context: TenantTransactionContext,
    dto: CreateCustomerDto,
  ): Promise<CustomerMutationResponse> {
    let input: PreparedCustomerCreate;
    try {
      const name = cleanCustomerDisplayName(dto.name);
      const phone = cleanCustomerDisplayPhone(dto.phone);
      const normalizedName = normalizeCustomerName(name);
      const normalizedPhone = normalizeCustomerPhone(phone);
      const notes = dto.notes ?? null;
      input = {
        customerId: dto.id,
        operationId: dto.operationId,
        name,
        normalizedName,
        phone,
        normalizedPhone,
        notes,
        requestHash: this.hashRequest({
          v: CUSTOMER_NORMALIZATION_VERSION,
          action: 'create',
          customerId: dto.id,
          name,
          normalizedName,
          phone,
          normalizedPhone,
          notes,
        }),
      };
    } catch (error) {
      this.rethrowNormalizationError(error);
    }

    return this.unwrap(await this.repository.create(context, input));
  }

  async update(
    context: TenantTransactionContext,
    customerId: string,
    dto: UpdateCustomerDto,
  ): Promise<CustomerMutationResponse> {
    if (dto.name === undefined && dto.phone === undefined && dto.notes === undefined) {
      throw this.validationException('body', 'customerMutableField');
    }

    const expectedVersion = BigInt(dto.expectedVersion);
    if (expectedVersion > maximumPostgreSqlBigint) {
      throw this.validationException('expectedVersion', 'maxPostgreSqlBigint');
    }

    let input: PreparedCustomerUpdate;
    try {
      const name = dto.name === undefined ? undefined : cleanCustomerDisplayName(dto.name);
      const normalizedName = name === undefined ? undefined : normalizeCustomerName(name);
      const phone = dto.phone === undefined ? undefined : cleanCustomerDisplayPhone(dto.phone);
      const normalizedPhone = phone === undefined ? undefined : normalizeCustomerPhone(phone);
      const canonicalPayload: Record<string, unknown> = {
        v: CUSTOMER_NORMALIZATION_VERSION,
        action: 'update',
        customerId,
        operationId: dto.operationId,
        expectedVersion: expectedVersion.toString(),
      };
      if (name !== undefined && normalizedName !== undefined) {
        canonicalPayload.name = name;
        canonicalPayload.normalizedName = normalizedName;
      }
      if (phone !== undefined && normalizedPhone !== undefined) {
        canonicalPayload.phone = phone;
        canonicalPayload.normalizedPhone = normalizedPhone;
      }
      if (dto.notes !== undefined) {
        canonicalPayload.notes = dto.notes;
      }
      input = {
        customerId,
        operationId: dto.operationId,
        expectedVersion,
        name,
        normalizedName,
        phone,
        normalizedPhone,
        notes: dto.notes,
        requestHash: this.hashRequest(canonicalPayload),
      };
    } catch (error) {
      this.rethrowNormalizationError(error);
    }

    return this.unwrap(await this.repository.update(context, input));
  }

  private hashRequest(payload: object): string {
    return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  }

  private unwrap(result: CustomerMutationResult): CustomerMutationResponse {
    if (result.ok) {
      return result.response;
    }
    this.throwMutationFailure(result.error);
  }

  private throwMutationFailure(error: CustomerMutationFailure): never {
    const payload = { code: error.code, message: error.message };
    if (error.statusCode === 404) {
      throw new NotFoundException(payload);
    }
    throw new ConflictException(payload);
  }

  private rethrowNormalizationError(error: unknown): never {
    if (error instanceof CustomerNormalizationError) {
      const field = error.code.includes('NAME') ? 'name' : 'phone';
      throw this.validationException(field, error.code);
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
