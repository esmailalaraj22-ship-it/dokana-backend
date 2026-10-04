import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { IssueOfflineLicenseDto } from './dto/issue-offline-license.dto';
import { OfflineLicenseService } from './offline-license.service';
import type { OfflineLicenseResponse } from './offline-license.types';

@Controller('licenses')
@UseGuards(AuthenticationGuard)
export class OfflineLicenseController {
  constructor(private readonly licenses: OfflineLicenseService) {}

  @Post('verify')
  @HttpCode(200)
  verify(
    @Req() request: AuthenticatedRequest,
    @Body() body: IssueOfflineLicenseDto,
  ): Promise<OfflineLicenseResponse> {
    return this.licenses.issue(request.principal, request.tenantContext, body);
  }
}
