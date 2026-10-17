import { ApiProperty } from '@nestjs/swagger';

import { notificationTypes } from '../../database/schema';

export class NotificationSubjectResponseDto {
  @ApiProperty({ type: String, example: 'customer' })
  type!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;
}

export class NotificationItemResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: notificationTypes })
  type!: (typeof notificationTypes)[number];

  @ApiProperty({ enum: ['info', 'warning', 'critical'] })
  severity!: 'info' | 'warning' | 'critical';

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  body!: string;

  @ApiProperty({ type: NotificationSubjectResponseDto, nullable: true })
  subject!: NotificationSubjectResponseDto | null;

  @ApiProperty({ enum: ['active', 'resolved'] })
  lifecycle!: 'active' | 'resolved';

  @ApiProperty({ type: Boolean })
  read!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class NotificationListResponseDto {
  @ApiProperty({ type: [NotificationItemResponseDto] })
  items!: NotificationItemResponseDto[];

  @ApiProperty({ type: String, nullable: true, maxLength: 768 })
  nextCursor!: string | null;
}

export class NotificationReadStateResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: Boolean })
  read!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt!: string | null;
}

export class NotificationSettingsResponseDto {
  @ApiProperty({
    type: String,
    pattern: '^(0|[1-9][0-9]*)$',
    description: 'Exact Store-currency minor units; never a floating-point value.',
  })
  customerDebtAmountAlertMinor!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  debtAgeAlertDays!: number;

  @ApiProperty({ type: Boolean })
  lowStockAlertEnabled!: boolean;

  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$' })
  version!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class NotificationSettingsMutationResponseDto extends NotificationSettingsResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  operationId!: string;
}
