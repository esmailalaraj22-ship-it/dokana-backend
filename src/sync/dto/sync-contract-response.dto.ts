import { ApiProperty } from '@nestjs/swagger';

export const offlineOperationOutcomes = [
  'APPLIED',
  'EXACT_REPLAY',
  'REJECTED',
  'DEPENDENCY_PENDING',
  'CONFLICT',
  'QUARANTINED',
] as const;

export class SyncApiErrorResponseDto {
  @ApiProperty({ type: Number, example: 410 })
  statusCode!: number;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  message!: string;

  @ApiProperty({ type: String })
  requestId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  timestamp!: string;

  @ApiProperty({ type: String })
  path!: string;
}

export class SyncRebootstrapRequiredErrorResponseDto {
  @ApiProperty({ enum: [410] })
  statusCode!: 410;

  @ApiProperty({ enum: ['SYNC_REBOOTSTRAP_REQUIRED'] })
  code!: 'SYNC_REBOOTSTRAP_REQUIRED';

  @ApiProperty({ type: String })
  message!: string;

  @ApiProperty({ type: String })
  requestId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  timestamp!: string;

  @ApiProperty({ type: String })
  path!: string;
}

export class OfflineOperationResultResponseDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  operationId!: string | null;

  @ApiProperty({ enum: offlineOperationOutcomes })
  status!: (typeof offlineOperationOutcomes)[number];

  @ApiProperty({ type: String, nullable: true })
  code!: string | null;

  @ApiProperty({ type: Object, additionalProperties: true, nullable: true })
  response!: Record<string, unknown> | null;
}

export class OfflineOperationPushResponseDto {
  @ApiProperty({ type: () => [OfflineOperationResultResponseDto] })
  results!: OfflineOperationResultResponseDto[];
}

export class BootstrapDatasetManifestResponseDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: Number })
  order!: number;

  @ApiProperty({ type: Number })
  recordCount!: number;

  @ApiProperty({ type: Number })
  pageCount!: number;

  @ApiProperty({ type: String, pattern: '^[0-9a-f]{64}$' })
  checksum!: string;
}

export class BootstrapActivationContractResponseDto {
  @ApiProperty({ enum: ['separate_sqlite_database'] })
  stagingModel!: 'separate_sqlite_database';

  @ApiProperty({
    type: [String],
    enum: ['page_checksums', 'dataset_checksums', 'manifest_checksum', 'foreign_keys'],
  })
  validation!: string[];

  @ApiProperty({ enum: ['atomic_database_swap_with_base_cursor'] })
  activation!: 'atomic_database_swap_with_base_cursor';

  @ApiProperty({ enum: ['must_not_activate'] })
  incompleteBootstrap!: 'must_not_activate';
}

export class BootstrapEncodingResponseDto {
  @ApiProperty({ enum: ['decimal_string'] })
  bigInteger!: 'decimal_string';

  @ApiProperty({ enum: ['integer_milli_units_as_decimal_string'] })
  quantity!: 'integer_milli_units_as_decimal_string';

  @ApiProperty({ enum: ['integer_minor_units_as_decimal_string'] })
  money!: 'integer_minor_units_as_decimal_string';

  @ApiProperty({ enum: ['rfc3339_utc'] })
  timestamp!: 'rfc3339_utc';
}

export class BootstrapManifestResponseDto {
  @ApiProperty({ enum: [1] })
  bootstrapVersion!: 1;

  @ApiProperty({ enum: [1] })
  protocolVersion!: 1;

  @ApiProperty({ enum: [1] })
  changeFeedVersion!: 1;

  @ApiProperty({ enum: [10300] })
  sqliteSchemaVersion!: 10300;

  @ApiProperty({ type: String, format: 'uuid' })
  sessionId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  datasetId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'Identity of this generated bootstrap artifact set; distinct from recovery authority.',
  })
  bootstrapGenerationId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'Current server Recovery Generation. A stale client generation requires a new bootstrap.',
  })
  recoveryGenerationId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  storeId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  deviceId!: string;

  @ApiProperty({ enum: ['ready'] })
  status!: 'ready';

  @ApiProperty({ type: String, format: 'date-time' })
  serverTime!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({ type: String })
  snapshotId!: string;

  @ApiProperty({
    type: String,
    description: 'Server-issued base cursor bound to the Store and Recovery Generation.',
  })
  baseCursor!: string;

  @ApiProperty({ type: Number })
  pageSize!: number;

  @ApiProperty({ type: BootstrapEncodingResponseDto })
  encoding!: BootstrapEncodingResponseDto;

  @ApiProperty({ type: BootstrapActivationContractResponseDto })
  activationContract!: BootstrapActivationContractResponseDto;

  @ApiProperty({ type: () => [BootstrapDatasetManifestResponseDto] })
  datasets!: BootstrapDatasetManifestResponseDto[];

  @ApiProperty({ type: String, pattern: '^[0-9a-f]{64}$' })
  manifestChecksum!: string;
}

export class ChangePullItemResponseDto {
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$' })
  sequence!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  eventId!: string;

  @ApiProperty({ enum: [1] })
  changeContractVersion!: 1;

  @ApiProperty({ enum: [1] })
  representationVersion!: 1;

  @ApiProperty({ type: String })
  entityType!: string;

  @ApiProperty({ type: String })
  entityKey!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  entityId!: string | null;

  @ApiProperty({ type: String })
  action!: string;

  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$' })
  entityVersion!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  operationId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  deviceId!: string | null;

  @ApiProperty({ type: Object, additionalProperties: true })
  representation!: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  capturedAt!: string;
}

export class ChangePullResponseDto {
  @ApiProperty({ enum: [1] })
  changeFeedVersion!: 1;

  @ApiProperty({ type: () => [ChangePullItemResponseDto] })
  changes!: ChangePullItemResponseDto[];

  @ApiProperty({
    type: String,
    description: 'Signed server cursor bound to the authenticated Store and Recovery Generation.',
  })
  nextCursor!: string;

  @ApiProperty({ type: Boolean })
  hasMore!: boolean;
}
