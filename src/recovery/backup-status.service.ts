import { ForbiddenException, Injectable } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { BackupStatusResponseDto } from './dto/backup-status-response.dto';
import { RecoveryHealthService } from './recovery-health.service';

type BackupStatusPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class BackupStatusService {
  constructor(private readonly health: RecoveryHealthService) {}

  async get(
    principal: BackupStatusPrincipal,
    context: TenantTransactionContext,
  ): Promise<BackupStatusResponseDto> {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'BACKUP_STATUS_ACCESS_NOT_ALLOWED',
        message: 'Backup status access is not allowed.',
      });
    }
    const health = await this.health.evaluate();
    return {
      protectionStatus: health.protectionStatus,
      logicalBackupStatus: health.logicalBackupStatus,
      pitrStatus: health.pitrStatus,
      lastVerifiedRecoveryPointAt: health.lastVerifiedRecoveryPointAt?.toISOString() ?? null,
      attentionRequired: health.attentionRequired,
    };
  }
}
