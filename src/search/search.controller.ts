import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { GlobalSearchQueryDto } from './dto/global-search-query.dto';
import { SearchService } from './search.service';
import type { GlobalSearchResponse } from './search.types';

@Controller('search')
@UseGuards(AuthenticationGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  search(
    @Req() request: AuthenticatedRequest,
    @Query() query: GlobalSearchQueryDto,
  ): Promise<GlobalSearchResponse> {
    return this.searchService.search(request.principal, request.tenantContext, query);
  }
}
