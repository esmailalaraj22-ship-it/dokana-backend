import { IsUUID } from 'class-validator';

export class MoneyAccountIdParamDto {
  @IsUUID()
  moneyAccountId!: string;
}
