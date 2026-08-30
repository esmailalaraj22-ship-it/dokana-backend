import { Controller, Get, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { AppSettingsReadService } from './app-settings-read.service';
import type { AppSettingsReadModel } from './app-settings.types';

@Controller('settings')
@UseGuards(AuthenticationGuard)
export class SettingsController {
  constructor(private readonly settingsReads: AppSettingsReadService) {}

  @Get()
  get(@Req() request: AuthenticatedRequest): Promise<AppSettingsReadModel> {
    return this.settingsReads.get(request.principal, request.tenantContext);
  }
}
