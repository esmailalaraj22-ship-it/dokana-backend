import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { NotificationIdParamDto } from './dto/notification-id-param.dto';
import {
  NotificationListResponseDto,
  NotificationReadStateResponseDto,
  NotificationSettingsMutationResponseDto,
  NotificationSettingsResponseDto,
} from './dto/notification-response.dto';
import { UpdateNotificationReadStateDto } from './dto/update-notification-read-state.dto';
import { UpdateNotificationSettingsDto } from './dto/update-notification-settings.dto';
import { NotificationSettingsService } from './notification-settings.service';
import { NotificationService } from './notification.service';
@Controller('notifications')
@UseGuards(AuthenticationGuard)
@ApiTags('Notifications')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Authentication is required.' })
@ApiForbiddenResponse({ description: 'Owner notification access is not allowed.' })
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly settings: NotificationSettingsService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'notifications.list',
    summary: 'List owner in-app notifications',
    description:
      'Returns bounded Store-scoped notification episodes with canonical active/resolved lifecycle and user-specific read state.',
  })
  @ApiOkResponse({ description: 'Notification page.', type: NotificationListResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or cursor.' })
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<NotificationListResponseDto> {
    return this.notifications.list(request.principal, request.tenantContext, query);
  }

  @Get('settings')
  @ApiOperation({
    operationId: 'notifications.settings.read',
    summary: 'Read notification settings',
  })
  @ApiOkResponse({
    description: 'Current notification settings.',
    type: NotificationSettingsResponseDto,
  })
  getSettings(@Req() request: AuthenticatedRequest): Promise<NotificationSettingsResponseDto> {
    return this.settings.get(request.principal, request.tenantContext);
  }

  @Patch('settings')
  @ApiOperation({
    operationId: 'notifications.settings.update',
    summary: 'Update notification settings',
    description: 'Uses the idempotent Store settings write authority and is blocked in READ_ONLY.',
  })
  @ApiOkResponse({
    description: 'Updated notification settings.',
    type: NotificationSettingsMutationResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid notification settings request.' })
  updateSettings(
    @Req() request: AuthenticatedRequest,
    @Body() body: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettingsMutationResponseDto> {
    return this.settings.update(request.principal, request.tenantContext, body);
  }

  @Patch(':notificationId/read-state')
  @ApiOperation({
    operationId: 'notifications.readState.update',
    summary: 'Mark a notification read or unread',
    description:
      'Updates only the authenticated user presentation state; canonical cause resolution is unchanged.',
  })
  @ApiOkResponse({
    description: 'Updated user-specific read state.',
    type: NotificationReadStateResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Notification was not found in the current Store.' })
  setReadState(
    @Req() request: AuthenticatedRequest,
    @Param() params: NotificationIdParamDto,
    @Body() body: UpdateNotificationReadStateDto,
  ): Promise<NotificationReadStateResponseDto> {
    return this.notifications.setReadState(
      request.principal,
      request.tenantContext,
      params.notificationId,
      body.read,
    );
  }
}
