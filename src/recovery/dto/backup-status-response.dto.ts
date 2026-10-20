import { ApiProperty } from '@nestjs/swagger';

export class BackupStatusResponseDto {
  @ApiProperty({
    enum: ['protected', 'attention_required', 'configuration_required'],
    description: 'Safe high-level protection state. It does not claim a measured RPO.',
  })
  protectionStatus!: 'protected' | 'attention_required' | 'configuration_required';

  @ApiProperty({ enum: ['healthy', 'attention_required', 'unconfigured'] })
  logicalBackupStatus!: 'healthy' | 'attention_required' | 'unconfigured';

  @ApiProperty({ enum: ['available', 'unavailable', 'unverified'] })
  pitrStatus!: 'available' | 'unavailable' | 'unverified';

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastVerifiedRecoveryPointAt!: string | null;

  @ApiProperty({ type: Boolean })
  attentionRequired!: boolean;
}
