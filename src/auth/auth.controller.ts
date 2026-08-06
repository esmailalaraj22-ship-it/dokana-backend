import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AuthenticationService } from './auth.service';
import type { AuthenticatedPrincipal, AuthenticationResponse, AuthorizedStore } from './auth.types';
import { AuthenticationGuard, type AuthenticatedRequest } from './authentication.guard';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';

@Controller('auth')
export class AuthenticationController {
  constructor(private readonly authentication: AuthenticationService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() input: LoginDto, @Req() request: Request): Promise<AuthenticationResponse> {
    return this.authentication.login(input, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() input: RefreshDto): Promise<AuthenticationResponse> {
    return this.authentication.refresh(input.refreshToken);
  }

  @Post('logout')
  @UseGuards(AuthenticationGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() request: AuthenticatedRequest): Promise<void> {
    await this.authentication.logout(request.principal);
  }

  @Get('me')
  @UseGuards(AuthenticationGuard)
  getCurrentIdentity(@Req() request: AuthenticatedRequest): AuthenticatedPrincipal {
    return request.principal;
  }

  @Get('stores')
  @UseGuards(AuthenticationGuard)
  listAuthorizedStores(@Req() request: AuthenticatedRequest): Promise<AuthorizedStore[]> {
    return this.authentication.listAuthorizedStores(request.principal.userId);
  }
}
