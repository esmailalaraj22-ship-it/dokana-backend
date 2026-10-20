import { Inject, Injectable } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import type { NotificationCause } from '../notifications/notification.types';
import { AttachmentRecoveryCatalogService } from './attachment-recovery-catalog.service';
import { PITR_STATUS, type PitrStatusPort } from './pitr-status.port';
import { RecoveryCatalogService } from './recovery-catalog.service';

export interface RecoveryHealth {
  protectionStatus: 'protected' | 'attention_required' | 'configuration_required';
  logicalBackupStatus: 'healthy' | 'attention_required' | 'unconfigured';
  pitrStatus: 'available' | 'unavailable' | 'unverified';
  lastVerifiedRecoveryPointAt: Date | null;
  attentionRequired: boolean;
}

@Injectable()
export class RecoveryHealthService {
  constructor(
    private readonly config: AppConfigService,
    private readonly catalog: RecoveryCatalogService,
    private readonly attachmentCatalog: AttachmentRecoveryCatalogService,
    @Inject(PITR_STATUS) private readonly pitr: PitrStatusPort,
  ) {}

  async evaluate(now = new Date()): Promise<RecoveryHealth> {
    const pitr = await this.pitr.readStatus();
    if (!this.catalog.configured) {
      const attentionRequired = this.config.recovery.applicationEnvironment === 'production';
      return {
        protectionStatus: attentionRequired ? 'attention_required' : 'configuration_required',
        logicalBackupStatus: 'unconfigured',
        pitrStatus: pitr.status,
        lastVerifiedRecoveryPointAt: null,
        attentionRequired,
      };
    }

    try {
      const catalog = await this.attachmentCatalog.inspectCoherentCatalog();
      const lastVerified = catalog.latestVerified
        ? new Date(catalog.latestVerified.verifiedAt)
        : null;
      const maximumAgeMs = this.config.recovery.logicalMaximumAgeHours * 60 * 60 * 1_000;
      const logicalHealthy =
        lastVerified !== null &&
        lastVerified.getTime() <= now.getTime() &&
        now.getTime() - lastVerified.getTime() <= maximumAgeMs &&
        catalog.invalidCount === 0;
      const pitrFailed = pitr.status === 'unavailable';
      const attentionRequired = !logicalHealthy || pitrFailed;
      return {
        protectionStatus: attentionRequired ? 'attention_required' : 'protected',
        logicalBackupStatus: logicalHealthy ? 'healthy' : 'attention_required',
        pitrStatus: pitr.status,
        lastVerifiedRecoveryPointAt: lastVerified,
        attentionRequired,
      };
    } catch {
      return {
        protectionStatus: 'attention_required',
        logicalBackupStatus: 'attention_required',
        pitrStatus: pitr.status,
        lastVerifiedRecoveryPointAt: null,
        attentionRequired: true,
      };
    }
  }

  async notificationCause(storeId: string, now = new Date()): Promise<NotificationCause | null> {
    const health = await this.evaluate(now);
    if (!health.attentionRequired) return null;
    return {
      key: `s21:v1:backup_failure:backup_protection:${storeId}`,
      type: 'backup_failure',
      severity: 'critical',
      title: 'Backup protection needs attention',
      body: 'There is a problem protecting your Store data backup.',
      entityType: 'backup_protection',
      entityId: storeId,
    };
  }
}
