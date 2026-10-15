import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiS20JsonOperation } from '../api-contract/s20-openapi.decorators';
import { S20_SCHEMA_NAMES } from '../api-contract/s20-openapi.schemas';
import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { GlobalSearchQueryDto } from './dto/global-search-query.dto';
import { SearchService } from './search.service';
import type { GlobalSearchResponse } from './search.types';

@Controller('search')
@UseGuards(AuthenticationGuard)
@ApiTags('Search')
@ApiBearerAuth('bearer')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiS20JsonOperation({
    operationId: 'search.global',
    summary: 'Search canonical Store records',
    description:
      'Returns bounded Store-scoped discovery results that identify canonical resources; it is not a report or accounting authority. Corrected and archived statuses remain truthful.',
    schemaName: S20_SCHEMA_NAMES.search,
    validation: true,
  })
  search(
    @Req() request: AuthenticatedRequest,
    @Query() query: GlobalSearchQueryDto,
  ): Promise<GlobalSearchResponse> {
    return this.searchService.search(request.principal, request.tenantContext, query);
  }
}
