import { Module } from '@nestjs/common';

import { databaseProviders } from './database.providers';
import { DatabaseService } from './database.service';
import { DRIZZLE_DATABASE } from './database.constants';

@Module({
  providers: [...databaseProviders, DatabaseService],
  exports: [DatabaseService, DRIZZLE_DATABASE],
})
export class DatabaseModule {}
