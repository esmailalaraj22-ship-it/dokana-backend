import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SupplierIdParamDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Canonical Supplier identifier.' })
  @IsUUID()
  supplierId!: string;
}
