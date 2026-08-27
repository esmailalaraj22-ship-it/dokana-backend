import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { SupplierReadRepository } from './supplier-read.repository';
import { SupplierReadService } from './supplier-read.service';
import { SuppliersController } from './suppliers.controller';
import { SupplierWriteRepository } from './supplier-write.repository';
import { SupplierWriteService } from './supplier-write.service';

@Module({
  imports: [AuthenticationModule, DatabaseModule],
  controllers: [SuppliersController],
  providers: [
    SupplierReadRepository,
    SupplierReadService,
    SupplierWriteRepository,
    SupplierWriteService,
  ],
})
export class SuppliersModule {}
