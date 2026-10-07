import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { BootstrapService } from './bootstrap.service';
import type { BootstrapManifest, BootstrapPage } from './bootstrap.types';
import { BootstrapPageParamDto } from './dto/bootstrap-page-param.dto';
import { StartBootstrapDto } from './dto/start-bootstrap.dto';

@Controller('sync/bootstrap')
@UseGuards(AuthenticationGuard)
export class BootstrapController {
  constructor(private readonly bootstraps: BootstrapService) {}

  @Post()
  @HttpCode(200)
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
