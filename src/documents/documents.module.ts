import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { ReportsModule } from '../reports/reports.module';
import { SalesModule } from '../sales/sales.module';
import { DocumentPdfRenderer } from './document-pdf.renderer';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  imports: [AuthenticationModule, ReportsModule, SalesModule],
  controllers: [DocumentsController],
  providers: [DocumentPdfRenderer, DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
