import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { AppSettingsReadService } from './app-settings-read.service';
import { AppSettingsWriteService } from './app-settings-write.service';
import type { AppSettingsMutationResponse, AppSettingsReadModel } from './app-settings.types';
import { UpdateAppSettingsDto } from './dto/update-app-settings.dto';

@Controller('settings')
@UseGuards(AuthenticationGuard)
export class SettingsController {
  constructor(
    private readonly settingsReads: AppSettingsReadService,
    private readonly settingsWrites: AppSettingsWriteService,
  ) {}

  @Get()
  get(@Req() request: AuthenticatedRequest): Promise<AppSettingsReadModel> {
    return this.settingsReads.get(request.principal, request.tenantContext);
  }

  @Patch()
  update(
    @Req() request: AuthenticatedRequest,
    @Body() body: UpdateAppSettingsDto,
  ): Promise<AppSettingsMutationResponse> {
    return this.settingsWrites.update(request.principal, request.tenantContext, body);
  }
}
