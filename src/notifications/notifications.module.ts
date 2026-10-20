import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { RecoveryModule } from '../recovery/recovery.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationReconcilerService } from './notification-reconciler.service';
import { NotificationRepository } from './notification.repository';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationSettingsService } from './notification-settings.service';
import { NotificationService } from './notification.service';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [AuthenticationModule, DatabaseModule, RecoveryModule, SettingsModule],
  controllers: [NotificationsController],
  providers: [
    NotificationRepository,
    NotificationReconcilerService,
    NotificationSchedulerService,
    NotificationSettingsService,
    NotificationService,
  ],
})
export class NotificationsModule {}
