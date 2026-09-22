import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CreateExpenseCategoryDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  operationId!: string;

  @IsString()
  name!: string;
}

export class UpdateExpenseCategoryDto {
  @IsUUID()
  operationId!: string;

  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d*$/)
  expectedVersion!: string;

  @IsString()
  name!: string;
}

export class ExpenseCategoryLifecycleDto {
  @IsUUID()
  operationId!: string;

  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d*$/)
  expectedVersion!: string;
}

export class ExpenseCategoryIdParamDto {
  @IsUUID()
  expenseCategoryId!: string;
}

export class ListExpenseCategoriesQueryDto {
  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';
}
