import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { AuditService } from './audit.service';
import { AuditListResponseDto } from './dto/audit-response.dto';
import { ListAuditQueryDto } from './dto/list-audit-query.dto';

@Controller('audit')
@UseGuards(AuthenticationGuard)
@ApiTags('Business Audit')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Authentication is required.' })
@ApiForbiddenResponse({ description: 'Store Owner business-audit access is not allowed.' })
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({
    operationId: 'audit.list',
    summary: 'List privacy-safe Store business history',
    description:
      'Returns a bounded newest-first Owner timeline of sanitized semantic business events. READ_ONLY Store Owners may read; raw central audit evidence is never exposed.',
  })
  @ApiOkResponse({
    description: 'Sanitized Store business-audit page.',
    type: AuditListResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid filter, date range, or cursor.' })
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListAuditQueryDto,
  ): Promise<AuditListResponseDto> {
    return this.audit.list(request.principal, request.tenantContext, query);
  }
}
