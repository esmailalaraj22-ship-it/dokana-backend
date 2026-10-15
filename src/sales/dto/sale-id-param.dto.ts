import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SaleIdParamDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Canonical Sale identifier.' })
  @IsUUID()
  saleId!: string;
}
