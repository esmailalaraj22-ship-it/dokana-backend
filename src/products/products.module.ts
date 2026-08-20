import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ProductReadRepository } from './product-read.repository';
import { ProductReadService } from './product-read.service';
import { ProductsController } from './products.controller';
import { ProductWriteRepository } from './product-write.repository';
import { ProductWriteService } from './product-write.service';

@Module({
  imports: [AuthenticationModule, DatabaseModule],
  controllers: [ProductsController],
  providers: [
    ProductReadRepository,
    ProductReadService,
    ProductWriteRepository,
    ProductWriteService,
  ],
})
export class ProductsModule {}
