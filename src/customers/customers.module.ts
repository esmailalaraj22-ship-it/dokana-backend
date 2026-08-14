import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { CustomerReadRepository } from './customer-read.repository';
import { CustomerReadService } from './customer-read.service';
import { CustomerWriteRepository } from './customer-write.repository';
import { CustomerWriteService } from './customer-write.service';
import { CustomersController } from './customers.controller';

@Module({
  imports: [AuthenticationModule, DatabaseModule],
  controllers: [CustomersController],
  providers: [
    CustomerReadRepository,
    CustomerReadService,
    CustomerWriteRepository,
    CustomerWriteService,
  ],
})
export class CustomersModule {}
