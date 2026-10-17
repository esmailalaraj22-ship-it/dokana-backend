import { ApiProperty } from '@nestjs/swagger';

import { auditBusinessActions, auditBusinessEntityTypes } from '../audit.types';

export class AuditEntityResponseDto {
  @ApiProperty({ enum: auditBusinessEntityTypes })
  type!: (typeof auditBusinessEntityTypes)[number];

  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  reference!: string | null;
}

export class AuditActorResponseDto {
  @ApiProperty({ enum: ['user', 'system'] })
  type!: 'user' | 'system';

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  userId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Safe display name only; authentication identifiers are excluded.',
  })
  displayName!: string | null;
}

export class AuditBusinessItemResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: auditBusinessActions,
    description: 'Stable semantic business action; this is the machine-readable contract.',
  })
  action!: (typeof auditBusinessActions)[number];

  @ApiProperty({ type: String, description: 'Deterministic display summary for the action.' })
  summary!: string;

  @ApiProperty({ type: AuditEntityResponseDto })
  entity!: AuditEntityResponseDto;

  @ApiProperty({ type: AuditActorResponseDto })
  actor!: AuditActorResponseDto;

  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  businessDate!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Allow-listed business context. Raw row snapshots, authentication data, network metadata, and synchronization internals are never returned.',
  })
  context!: Record<string, unknown>;
}

export class AuditListResponseDto {
  @ApiProperty({ type: [AuditBusinessItemResponseDto] })
  items!: AuditBusinessItemResponseDto[];

  @ApiProperty({ type: String, nullable: true, maxLength: 768 })
  nextCursor!: string | null;
}
