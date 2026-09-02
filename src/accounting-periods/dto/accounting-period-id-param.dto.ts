import { IsUUID } from 'class-validator';

export class AccountingPeriodIdParamDto {
  @IsUUID()
  accountingPeriodId!: string;
}
