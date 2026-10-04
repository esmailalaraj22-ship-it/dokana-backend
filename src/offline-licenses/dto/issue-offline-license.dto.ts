import { IsUUID } from 'class-validator';

export class IssueOfflineLicenseDto {
  @IsUUID()
  operationId!: string;
}
