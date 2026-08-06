import { Module } from '@nestjs/common';

import { AuthenticationController } from './auth.controller';
import { authenticationDatabaseProviders } from './auth-database.providers';
import { AuthenticationDatabaseService } from './auth-database.service';
import { AuthenticationService } from './auth.service';
import { AuthenticationGuard } from './authentication.guard';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthenticationController],
  providers: [
    ...authenticationDatabaseProviders,
    AuthenticationDatabaseService,
    AuthenticationService,
    AuthenticationGuard,
    PasswordService,
    TokenService,
  ],
  exports: [AuthenticationDatabaseService, AuthenticationGuard, PasswordService, TokenService],
})
export class AuthenticationModule {}
