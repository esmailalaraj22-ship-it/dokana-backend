import { BadRequestException } from '@nestjs/common';
import { IsUUID } from 'class-validator';

export class InventoryProductParamDto {
  @IsUUID()
  productId!: string;
}

export class InventoryOperationParamDto {
  @IsUUID()
  operationId!: string;
}

export function assertNoInventoryQuery(query: object): void {
  if (Object.keys(query).length > 0) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Inventory detail reads accept no query parameters.',
    });
  }
}
