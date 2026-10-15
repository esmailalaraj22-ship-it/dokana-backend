import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CustomerIdParamDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Canonical Customer identifier.' })
  @IsUUID()
  customerId!: string;
}
