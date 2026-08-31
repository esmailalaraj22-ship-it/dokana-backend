import { IsIn, IsOptional } from 'class-validator';

import type { MoneyAccountListStatus } from '../money-account-read.types';

export class ListMoneyAccountsQueryDto {
  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: MoneyAccountListStatus;
}
