import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseModule } from '../database/database.module';
import {
  ATTACHMENT_MALWARE_SCANNER,
  UnavailableAttachmentMalwareScanner,
} from './attachment-malware-scanner.port';
import { AttachmentRepository } from './attachment.repository';
import { ATTACHMENT_STORAGE, UnavailableAttachmentStorage } from './attachment-storage.port';
import { AttachmentService } from './attachment.service';
import { AttachmentsController } from './attachments.controller';
import { ClamAvAttachmentMalwareScanner } from './clamav-attachment-malware-scanner';
import { S3AttachmentStorage } from './s3-attachment-storage';

@Module({
  imports: [AuthenticationModule, DatabaseModule],
  controllers: [AttachmentsController],
  providers: [
    AttachmentRepository,
    AttachmentService,
    {
      provide: ATTACHMENT_STORAGE,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        config.attachmentStorage
          ? new S3AttachmentStorage(config.attachmentStorage)
          : new UnavailableAttachmentStorage(),
    },
    {
      provide: ATTACHMENT_MALWARE_SCANNER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        config.attachmentScanner
          ? new ClamAvAttachmentMalwareScanner(config.attachmentScanner)
          : new UnavailableAttachmentMalwareScanner(),
    },
  ],
  exports: [AttachmentService, ATTACHMENT_STORAGE, ATTACHMENT_MALWARE_SCANNER],
})
export class AttachmentsModule {}
