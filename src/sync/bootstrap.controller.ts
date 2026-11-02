import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiGoneResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { BootstrapService } from './bootstrap.service';
import type { BootstrapManifest, BootstrapPage } from './bootstrap.types';
import { BootstrapPageParamDto } from './dto/bootstrap-page-param.dto';
import { StartBootstrapDto } from './dto/start-bootstrap.dto';
import {
  BootstrapManifestResponseDto,
  SyncApiErrorResponseDto,
  SyncRebootstrapRequiredErrorResponseDto,
} from './dto/sync-contract-response.dto';

@Controller('sync/bootstrap')
@UseGuards(AuthenticationGuard)
@ApiTags('Synchronization')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ type: SyncApiErrorResponseDto })
export class BootstrapController {
  constructor(private readonly bootstraps: BootstrapService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    operationId: 'sync.bootstrap.start',
    summary: 'Create a consistent Store bootstrap',
    description:
      'Returns distinct bootstrapGenerationId and recoveryGenerationId values plus the signed base cursor used for atomic local activation.',
  })
  @ApiOkResponse({ type: BootstrapManifestResponseDto })
  @ApiBadRequestResponse({ type: SyncApiErrorResponseDto })
  @ApiGoneResponse({
    description: 'Recovery authority changed and bootstrap must be restarted.',
    type: SyncRebootstrapRequiredErrorResponseDto,
  })
  start(
    @Req() request: AuthenticatedRequest,
    @Body() body: StartBootstrapDto,
  ): Promise<BootstrapManifest> {
    return this.bootstraps.start(request.principal, request.tenantContext, body);
  }

  @Get(':sessionId/datasets/:datasetId/pages/:pageNumber')
  readPage(
    @Req() request: AuthenticatedRequest,
    @Param() params: BootstrapPageParamDto,
  ): Promise<BootstrapPage> {
    return this.bootstraps.readPage(
      request.principal,
      request.tenantContext,
      params.sessionId,
      params.datasetId,
      params.pageNumber,
    );
  }
}
