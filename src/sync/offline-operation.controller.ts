import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';

import {
  SyncAuthenticationGuard,
  type SyncAuthenticatedRequest,
} from '../auth/sync-authentication.guard';
import { SyncAuthenticationService } from '../auth/sync-authentication.service';
import type { SyncAuthenticationResponse } from '../auth/auth.types';
import { RefreshDto } from '../auth/dto/refresh.dto';
import { PushOfflineOperationsDto } from './dto/push-offline-operations.dto';
import type { OfflineOperationPushResult } from './offline-operation.contract';
import { OfflineOperationService } from './offline-operation.service';

@Controller('sync')
export class OfflineOperationController {
  constructor(
    private readonly authentication: SyncAuthenticationService,
    private readonly operations: OfflineOperationService,
  ) {}

  @Post('auth/token')
  @HttpCode(HttpStatus.OK)
  issueSyncToken(@Body() input: RefreshDto): Promise<SyncAuthenticationResponse> {
    return this.authentication.issueFromRefreshToken(input.refreshToken);
  }

  @Post('push')
  @UseGuards(SyncAuthenticationGuard)
  @HttpCode(HttpStatus.OK)
  push(
    @Body() input: PushOfflineOperationsDto,
    @Req() request: SyncAuthenticatedRequest,
  ): Promise<{ results: OfflineOperationPushResult[] }> {
    return this.operations.push(input, request.principal, request.tenantContext);
  }
}
