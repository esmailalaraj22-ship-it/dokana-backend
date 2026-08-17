import { Module } from '@nestjs/common';

import { AuthenticationModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { LoggingModule } from './common/logging/logging.module';
import { ApplicationConfigModule } from './config/config.module';
import { CustomersModule } from './customers/customers.module';
import { HealthModule } from './health/health.module';
import { ProductsModule } from './products/products.module';

@Module({
  imports: [
    ApplicationConfigModule,
    LoggingModule,
    CommonModule,
    HealthModule,
    AuthenticationModule,
    CustomersModule,
    ProductsModule,
  ],
})
export class AppModule {}
