import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../database/database.service';
import type { HealthResponse } from './health.types';

@Injectable()
export class HealthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
  ) {}

  getLiveness(): HealthResponse {
    return this.createResponse('up', {
      application: { status: 'up' },
    });
  }

  async getReadiness(): Promise<HealthResponse> {
    const database = await this.database.checkReadiness(this.config.healthCheckTimeoutMs);
    const status = database.ready ? 'up' : 'down';

    return this.createResponse(status, {
      application: { status: 'up' },
      database: {
        status,
        latencyMs: database.latencyMs,
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
