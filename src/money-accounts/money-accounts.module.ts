import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { MoneyAccountReadRepository } from './money-account-read.repository';
import { MoneyAccountReadService } from './money-account-read.service';
import { MoneyAccountWriteRepository } from './money-account-write.repository';
import { MoneyAccountWriteService } from './money-account-write.service';
import { MoneyAccountsController } from './money-accounts.controller';
import { SystemCashProvisioningService } from './system-cash-provisioning.service';

@Module({
  imports: [AuthenticationModule, DatabaseModule],
  controllers: [MoneyAccountsController],
  providers: [
    MoneyAccountReadRepository,
    MoneyAccountReadService,
    MoneyAccountWriteRepository,
    MoneyAccountWriteService,
    SystemCashProvisioningService,
  ],
  exports: [SystemCashProvisioningService],
})
export class MoneyAccountsModule {}
