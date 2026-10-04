import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import type { AuthenticatedRequest } from '../auth/authentication.guard';
import { PlatformAuthorityService } from './platform-authority.service';

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly authority: PlatformAuthorityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!(await this.authority.isCurrentActorPlatformAdmin(request.tenantContext))) {
      throw new ForbiddenException({
        code: 'PLATFORM_ADMIN_REQUIRED',
        message: 'Platform administration access is required.',
      });
    }
    return true;
  }
}
