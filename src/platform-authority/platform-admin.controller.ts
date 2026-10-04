import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import {
  OfflineLicenseAdminListQueryDto,
  OfflineLicenseAdminParamDto,
  OfflineLicenseAdminStoreParamDto,
  RevokeOfflineLicenseDto,
} from '../offline-licenses/dto/offline-license-admin.dto';
import { OfflineLicenseAdminService } from '../offline-licenses/offline-license-admin.service';
import { PlatformAdminListQueryDto } from './dto/platform-admin-list-query.dto';
import { PlatformAdminProvisionStoreDto } from './dto/platform-admin-provision-store.dto';
import {
  PlatformAdminStoreLifecycleDto,
  PlatformAdminStoreLifecycleParamDto,
} from './dto/platform-admin-store-lifecycle.dto';
import { PlatformAdminStoreParamDto } from './dto/platform-admin-store-param.dto';
import {
  PlatformAdminSubscriptionActionParamDto,
  PlatformAdminSubscriptionMutationDto,
} from './dto/platform-admin-subscription-action.dto';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';

@Controller('admin/stores')
@UseGuards(AuthenticationGuard, PlatformAdminGuard)
export class PlatformAdminController {
  constructor(
    private readonly administration: PlatformAdminService,
    private readonly licenses: OfflineLicenseAdminService,
  ) {}

  @Get()
  listStores(
    @Req() request: AuthenticatedRequest,
    @Query() query: PlatformAdminListQueryDto,
  ): Promise<unknown> {
    return this.administration.listStores(request.tenantContext, query);
  }

  @Get(':storeId')
  getStore(
    @Req() request: AuthenticatedRequest,
    @Param() params: PlatformAdminStoreParamDto,
  ): Promise<unknown> {
    return this.administration.getStore(request.tenantContext, params.storeId);
  }

  @Get(':storeId/subscriptions')
  listSubscriptions(
    @Req() request: AuthenticatedRequest,
    @Param() params: PlatformAdminStoreParamDto,
  ): Promise<unknown> {
    return this.administration.listSubscriptions(request.tenantContext, params.storeId);
  }

  @Get(':storeId/subscriptions/history')
  listSubscriptionHistory(
    @Req() request: AuthenticatedRequest,
    @Param() params: PlatformAdminStoreParamDto,
  ): Promise<unknown> {
    return this.administration.listSubscriptionHistory(request.tenantContext, params.storeId);
  }

  @Get(':storeId/history')
  listHistory(
    @Req() request: AuthenticatedRequest,
    @Param() params: PlatformAdminStoreParamDto,
    @Query() query: PlatformAdminListQueryDto,
  ): Promise<unknown> {
    return this.administration.listHistory(request.tenantContext, params.storeId, query);
  }

  @Post()
  provisionStore(
    @Req() request: AuthenticatedRequest,
    @Body() body: PlatformAdminProvisionStoreDto,
  ): Promise<unknown> {
    return this.administration.provisionStore(request.tenantContext, body);
  }

  @Post(':storeId/subscriptions/:action')
  @HttpCode(200)
  mutateSubscription(
    @Req() request: AuthenticatedRequest,
    @Param() params: PlatformAdminSubscriptionActionParamDto,
    @Body() body: PlatformAdminSubscriptionMutationDto,
  ): Promise<unknown> {
    return this.administration.mutateSubscription(
      request.tenantContext,
      params.storeId,
      params.action,
      body,
    );
  }

  @Post(':storeId/lifecycle/:action')
  @HttpCode(200)
  mutateStoreLifecycle(
    @Req() request: AuthenticatedRequest,
    @Param() params: PlatformAdminStoreLifecycleParamDto,
    @Body() body: PlatformAdminStoreLifecycleDto,
  ): Promise<unknown> {
    return this.administration.mutateStoreLifecycle(
      request.tenantContext,
      params.storeId,
      params.action,
      body,
    );
  }

  @Get(':storeId/licenses')
  listLicenses(
    @Req() request: AuthenticatedRequest,
    @Param() params: OfflineLicenseAdminStoreParamDto,
    @Query() query: OfflineLicenseAdminListQueryDto,
  ): Promise<unknown> {
    return this.licenses.list(request.tenantContext, params.storeId, query);
  }

  @Post(':storeId/licenses/:licenseId/revoke')
  @HttpCode(200)
  revokeLicense(
    @Req() request: AuthenticatedRequest,
    @Param() params: OfflineLicenseAdminParamDto,
    @Body() body: RevokeOfflineLicenseDto,
  ): Promise<unknown> {
    return this.licenses.revoke(request.tenantContext, params.storeId, params.licenseId, body);
  }
}
