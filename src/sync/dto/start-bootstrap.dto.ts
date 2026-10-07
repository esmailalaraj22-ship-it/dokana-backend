import { Equals, IsInt, IsUUID } from 'class-validator';

export class StartBootstrapDto {
  @IsInt()
  @Equals(1)
  bootstrapVersion!: number;

  @IsUUID()
  licenseId!: string;
}
