import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { MoneyAccountReadRepository } from './money-account-read.repository';
import { MoneyAccountReadService } from './money-account-read.service';
import { MoneyAccountsController } from './money-accounts.controller';

@Module({
  imports: [AuthenticationModule, DatabaseModule],
  controllers: [MoneyAccountsController],
  providers: [MoneyAccountReadRepository, MoneyAccountReadService],
})
export class MoneyAccountsModule {}
