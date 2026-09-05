import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { InventoryController } from './inventory.controller';
import { InventoryReadRepository } from './inventory-read.repository';
import { InventoryReadService } from './inventory-read.service';

@Module({
  imports: [AuthenticationModule, DatabaseModule],
  controllers: [InventoryController],
  providers: [InventoryReadRepository, InventoryReadService],
})
export class InventoryModule {}
