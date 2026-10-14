import { ForbiddenException, Injectable } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { DashboardRepository } from './dashboard.repository';
import {
  DASHBOARD_RECENT_ACTIVITY_LIMIT,
  type DashboardResponse,
  type DashboardSnapshot,
} from './dashboard.types';

type DashboardPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class DashboardService {
  constructor(private readonly repository: DashboardRepository) {}

  async read(
    principal: DashboardPrincipal,
    context: TenantTransactionContext,
  ): Promise<DashboardResponse> {
    this.assertAuthorized(principal, context);
    return this.mapResponse(await this.repository.read(context));
  }

  private assertAuthorized(principal: DashboardPrincipal, context: TenantTransactionContext): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'DASHBOARD_READ_NOT_ALLOWED',
        message: 'Dashboard reads are not allowed.',
      });
    }
  }

  private mapResponse(snapshot: DashboardSnapshot): DashboardResponse {
    return {
      ...snapshot,
      asOf: snapshot.asOf.toISOString(),
      recentActivity: {
        limit: DASHBOARD_RECENT_ACTIVITY_LIMIT,
        items: snapshot.recentActivity.map((activity) => ({
          ...activity,
          occurredAt: activity.occurredAt.toISOString(),
        })),
      },
    };
  }
}
