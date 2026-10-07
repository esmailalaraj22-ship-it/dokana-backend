import { IsUUID, Matches } from 'class-validator';

export class BootstrapPageParamDto {
  @IsUUID()
  sessionId!: string;

  @Matches(/^[a-z][a-z0-9_]{0,62}$/)
  datasetId!: string;

  @Matches(/^[1-9]\d{0,7}$/)
  pageNumber!: string;
}
