import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiGoneResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import {
  SyncAuthenticationGuard,
  type SyncAuthenticatedRequest,
} from '../auth/sync-authentication.guard';
import { SyncAuthenticationService } from '../auth/sync-authentication.service';
import type { SyncAuthenticationResponse } from '../auth/auth.types';
import { RefreshDto } from '../auth/dto/refresh.dto';
import { PushOfflineOperationsDto } from './dto/push-offline-operations.dto';
import { OfflineOperationStatusQueryDto } from './dto/offline-operation-status-query.dto';
import { RecoverOfflineOperationDto } from './dto/recover-offline-operation.dto';
import {
  OfflineOperationPushResponseDto,
  SyncApiErrorResponseDto,
  SyncRebootstrapRequiredErrorResponseDto,
} from './dto/sync-contract-response.dto';
import type {
  OfflineOperationPushResult,
  OfflineOperationStatusResult,
} from './offline-operation.contract';
import { OfflineOperationService } from './offline-operation.service';

@Controller('sync')
@ApiTags('Synchronization')
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
  @ApiBearerAuth('bearer')
  @ApiOperation({
    operationId: 'sync.push',
    summary: 'Apply a bounded batch of offline operations',
    description:
      'Returns one of exactly six canonical outcomes per operation. Recovery Generation is validated before authoritative domain dispatch.',
  })
  @ApiOkResponse({ type: OfflineOperationPushResponseDto })
  @ApiBadRequestResponse({ type: SyncApiErrorResponseDto })
  @ApiUnauthorizedResponse({ type: SyncApiErrorResponseDto })
  @ApiGoneResponse({
    description: 'The client Recovery Generation is stale and a new bootstrap is required.',
    type: SyncRebootstrapRequiredErrorResponseDto,
  })
  push(
    @Body() input: PushOfflineOperationsDto,
    @Req() request: SyncAuthenticatedRequest,
  ): Promise<{ results: OfflineOperationPushResult[] }> {
    return this.operations.push(input, request.principal, request.tenantContext);
  }

  @Get('operations/:operationId')
  @UseGuards(SyncAuthenticationGuard)
  status(
    @Param('operationId') operationId: string,
    @Query() query: OfflineOperationStatusQueryDto,
    @Req() request: SyncAuthenticatedRequest,
  ): Promise<OfflineOperationStatusResult> {
    return this.operations.status(operationId, query.provenanceHash, request.tenantContext);
  }

  @Post('operations/:operationId/recover')
  @UseGuards(SyncAuthenticationGuard)
  @HttpCode(HttpStatus.OK)
  recover(
    @Param('operationId') operationId: string,
    @Body() input: RecoverOfflineOperationDto,
    @Req() request: SyncAuthenticatedRequest,
  ): Promise<OfflineOperationPushResult> {
    return this.operations.recover(operationId, input, request.principal, request.tenantContext);
  }
}
