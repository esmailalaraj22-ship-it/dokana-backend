import { Controller, Get, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { DashboardService } from './dashboard.service';
import type { DashboardResponse } from './dashboard.types';

@Controller('dashboard')
@UseGuards(AuthenticationGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  read(@Req() request: AuthenticatedRequest): Promise<DashboardResponse> {
    return this.dashboard.read(request.principal, request.tenantContext);
  }
}
