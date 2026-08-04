export type HealthStatus = 'up' | 'down';

export interface HealthCheck {
  status: HealthStatus;
  latencyMs?: number;
}

export interface HealthResponse {
  status: HealthStatus;
  timestamp: string;
  uptimeSeconds: number;
  environment: string;
  checks: {
    application: HealthCheck;
    database?: HealthCheck;
  };
}
