export const PITR_STATUS = Symbol('PITR_STATUS');

export interface PitrStatus {
  status: 'available' | 'unavailable' | 'unverified';
  retentionDays: number | null;
  latestRecoverableAt: Date | null;
}

export interface PitrStatusPort {
  readStatus(): Promise<PitrStatus>;
}

export class UnverifiedPitrStatus implements PitrStatusPort {
  readStatus(): Promise<PitrStatus> {
    return Promise.resolve({
      status: 'unverified',
      retentionDays: null,
      latestRecoverableAt: null,
    });
  }
}
