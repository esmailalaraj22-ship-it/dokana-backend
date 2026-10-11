import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { ChangePullService } from './change-pull.service';
import type { ChangePullResponse } from './change-pull.types';
import { PullChangesQueryDto } from './dto/pull-changes-query.dto';

@Controller('sync')
@UseGuards(AuthenticationGuard)
export class ChangePullController {
  constructor(private readonly changes: ChangePullService) {}

  @Get('pull')
  pull(
    @Req() request: AuthenticatedRequest,
    @Query() query: PullChangesQueryDto,
  ): Promise<ChangePullResponse> {
    return this.changes.pull(request.principal, request.tenantContext, query);
  }
}
