import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiS20JsonOperation } from '../api-contract/s20-openapi.decorators';
import { S20_SCHEMA_NAMES } from '../api-contract/s20-openapi.schemas';
import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { DashboardService } from './dashboard.service';
import type { DashboardResponse } from './dashboard.types';

@Controller('dashboard')
@UseGuards(AuthenticationGuard)
@ApiTags('Dashboard')
@ApiBearerAuth('bearer')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiS20JsonOperation({
    operationId: 'dashboard.read',
    summary: 'Read the Store dashboard',
    description:
      'Returns one bounded, repeatable-read Store snapshot using canonical Sales, Money, receivable, payable, inventory projection, and recent-activity authorities. Authorized READ_ONLY Store access remains readable.',
    schemaName: S20_SCHEMA_NAMES.dashboard,
  })
  read(@Req() request: AuthenticatedRequest): Promise<DashboardResponse> {
    return this.dashboard.read(request.principal, request.tenantContext);
  }
}
