import { Injectable } from '@nestjs/common';

import { AuthenticationDatabaseService } from '../auth/auth-database.service';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../database/database.service';
import type { HealthResponse } from './health.types';

@Injectable()
export class HealthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authenticationDatabase: AuthenticationDatabaseService,
    private readonly config: AppConfigService,
  ) {}

  getLiveness(): HealthResponse {
    return this.createResponse('up', {
      application: { status: 'up' },
    });
  }

  async getReadiness(): Promise<HealthResponse> {
    const [database, authenticationDatabase] = await Promise.all([
      this.database.checkReadiness(this.config.healthCheckTimeoutMs),
      this.authenticationDatabase.checkReadiness(this.config.healthCheckTimeoutMs),
    ]);
    const status = database.ready && authenticationDatabase.ready ? 'up' : 'down';

    return this.createResponse(status, {
      application: { status: 'up' },
      database: {
        status: database.ready ? 'up' : 'down',
        latencyMs: database.latencyMs,
      },
      authenticationDatabase: {
        status: authenticationDatabase.ready ? 'up' : 'down',
        latencyMs: authenticationDatabase.latencyMs,
      },
    });
  }

  private createResponse(
    status: HealthResponse['status'],
    checks: HealthResponse['checks'],
  ): HealthResponse {
    return {
      status,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      environment: this.config.environment,
      checks,
    };
  }
}
