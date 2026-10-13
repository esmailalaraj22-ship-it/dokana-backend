import { IsOptional, Matches } from 'class-validator';

export class OfflineOperationStatusQueryDto {
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/)
  provenanceHash?: string;
}
