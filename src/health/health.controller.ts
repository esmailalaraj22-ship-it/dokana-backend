import { Controller, Get, HttpStatus, VERSION_NEUTRAL } from '@nestjs/common';
import type { Response } from 'express';
import { Res } from '@nestjs/common';

import { HealthService } from './health.service';
import type { HealthResponse } from './health.types';

@Controller({
  path: 'health',
  version: VERSION_NEUTRAL,
})
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async getHealth(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    return this.respondWithReadinessStatus(response);
  }

  @Get('live')
  getLiveness(): HealthResponse {
    return this.health.getLiveness();
  }

  @Get('ready')
  async getReadiness(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    return this.respondWithReadinessStatus(response);
  }

  private async respondWithReadinessStatus(response: Response): Promise<HealthResponse> {
    const health = await this.health.getReadiness();
    response.status(health.status === 'up' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return health;
  }
}
