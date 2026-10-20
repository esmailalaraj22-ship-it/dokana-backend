import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { BackupStatusService } from './backup-status.service';
import { BackupStatusResponseDto } from './dto/backup-status-response.dto';

@Controller('backup-status')
@UseGuards(AuthenticationGuard)
@ApiTags('Recovery')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Authentication is required.' })
@ApiForbiddenResponse({ description: 'Owner backup-status access is not allowed.' })
export class BackupStatusController {
  constructor(private readonly backupStatus: BackupStatusService) {}

  @Get()
  @ApiOperation({
    operationId: 'recovery.backupStatus.read',
    summary: 'Read safe Store backup protection status',
    description:
      'Returns only high-level logical-backup and PITR protection state. Recovery artifacts, manifests, provider details, and operator diagnostics are never exposed.',
  })
  @ApiOkResponse({ description: 'Safe backup protection status.', type: BackupStatusResponseDto })
  get(@Req() request: AuthenticatedRequest): Promise<BackupStatusResponseDto> {
    return this.backupStatus.get(request.principal, request.tenantContext);
  }
}
