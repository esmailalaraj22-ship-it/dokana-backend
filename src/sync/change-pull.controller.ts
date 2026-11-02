import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiGoneResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { ChangePullService } from './change-pull.service';
import type { ChangePullResponse } from './change-pull.types';
import { PullChangesQueryDto } from './dto/pull-changes-query.dto';
import {
  ChangePullResponseDto,
  SyncApiErrorResponseDto,
  SyncRebootstrapRequiredErrorResponseDto,
} from './dto/sync-contract-response.dto';

@Controller('sync')
@UseGuards(AuthenticationGuard)
@ApiTags('Synchronization')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ type: SyncApiErrorResponseDto })
export class ChangePullController {
  constructor(private readonly changes: ChangePullService) {}

  @Get('pull')
  @ApiOperation({
    operationId: 'sync.pull',
    summary: 'Pull commit-ordered Store changes',
    description:
      'Consumes a signed Store/Recovery-Generation-bound cursor. A stale generation or replay window requires rebootstrap.',
  })
  @ApiOkResponse({ type: ChangePullResponseDto })
  @ApiBadRequestResponse({ type: SyncApiErrorResponseDto })
  @ApiGoneResponse({
    description: 'The cursor is stale and the client must perform a new bootstrap.',
    type: SyncRebootstrapRequiredErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({ type: SyncApiErrorResponseDto })
  pull(
    @Req() request: AuthenticatedRequest,
    @Query() query: PullChangesQueryDto,
  ): Promise<ChangePullResponse> {
    return this.changes.pull(request.principal, request.tenantContext, query);
  }
}
