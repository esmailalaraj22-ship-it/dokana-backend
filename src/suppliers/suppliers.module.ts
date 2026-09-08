import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { SupplierFinancialReadRepository } from './supplier-financial-read.repository';
import { SupplierFinancialReadService } from './supplier-financial-read.service';
import { SupplierReadRepository } from './supplier-read.repository';
import { SupplierReadService } from './supplier-read.service';
import { SuppliersController } from './suppliers.controller';
import { SupplierWriteRepository } from './supplier-write.repository';
import { SupplierWriteService } from './supplier-write.service';

@Module({
  imports: [AuthenticationModule, DatabaseModule],
  controllers: [SuppliersController],
  providers: [
    SupplierFinancialReadRepository,
    SupplierFinancialReadService,
    SupplierReadRepository,
    SupplierReadService,
    SupplierWriteRepository,
    SupplierWriteService,
  ],
})
export class SuppliersModule {}
