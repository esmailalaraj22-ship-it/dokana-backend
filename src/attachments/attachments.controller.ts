import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';

import { AuthenticationGuard, type AuthenticatedRequest } from '../auth/authentication.guard';
import { AttachmentService } from './attachment.service';
import { ATTACHMENT_MAX_BYTES } from './attachment.types';
import { AttachmentIdParamDto } from './dto/attachment-id-param.dto';
import { AttachmentParentDto } from './dto/attachment-parent.dto';
import {
  AttachmentListResponseDto,
  AttachmentMetadataResponseDto,
} from './dto/attachment-response.dto';

@Controller('attachments')
@UseGuards(AuthenticationGuard)
@ApiTags('Attachments')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Authentication is required.' })
@ApiForbiddenResponse({
  description: 'Owner authorization or Store write policy does not permit the operation.',
})
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: ATTACHMENT_MAX_BYTES,
        files: 1,
        fields: 2,
        parts: 4,
        fieldNameSize: 64,
        fieldSize: 128,
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    operationId: 'attachments.upload',
    summary: 'Upload one private attachment',
    description:
      'Owner-only business write for Customer, Product, Supplier, or Expense. Accepts PDF, JPEG, or PNG up to 10 MiB; each parent may have at most 10 active attachments. READ_ONLY Stores cannot upload.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['entityType', 'entityId', 'file'],
      properties: {
        entityType: { type: 'string', enum: ['customer', 'product', 'supplier', 'expense'] },
        entityId: { type: 'string', format: 'uuid' },
        file: {
          type: 'string',
          format: 'binary',
          description: 'One PDF, JPEG, or PNG file, at most 10 MiB.',
        },
      },
    },
  })
  @ApiCreatedResponse({ type: AttachmentMetadataResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid parent fields, filename, or file signature.' })
  @ApiNotFoundResponse({ description: 'The authorized Store parent was not found.' })
  @ApiConflictResponse({ description: 'Parent lifecycle or 10-active attachment limit conflict.' })
  @ApiPayloadTooLargeResponse({ description: 'The file exceeds 10 MiB.' })
  @ApiUnprocessableEntityResponse({ description: 'Security scanning rejected the file.' })
  @ApiServiceUnavailableResponse({ description: 'Secure storage or malware scanning unavailable.' })
  upload(
    @Req() request: AuthenticatedRequest,
    @Body() body: AttachmentParentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<AttachmentMetadataResponseDto> {
    return this.attachments.upload(request.principal, request.tenantContext, body, file);
  }

  @Get()
  @ApiOperation({
    operationId: 'attachments.list',
    summary: 'List active attachments for one parent',
    description:
      'Returns at most 10 active attachment metadata records in deterministic order. READ_ONLY Store Owners may list; storage internals are never returned.',
  })
  @ApiOkResponse({ type: AttachmentListResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid parent query.' })
  @ApiNotFoundResponse({ description: 'The authorized Store parent was not found.' })
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: AttachmentParentDto,
  ): Promise<AttachmentListResponseDto> {
    return this.attachments.list(request.principal, request.tenantContext, query);
  }

  @Get(':attachmentId/content')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    operationId: 'attachments.download',
    summary: 'Download active private attachment content',
    description:
      'Streams content only after Store, Owner, attachment, and parent authorization. Removed attachments are unavailable. READ_ONLY Store Owners may download.',
  })
  @ApiOkResponse({
    description: 'Validated private attachment content.',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
      'image/png': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiNotFoundResponse({ description: 'Attachment is missing, removed, or unauthorized.' })
  @ApiServiceUnavailableResponse({ description: 'Binary storage or integrity is unavailable.' })
  async download(
    @Req() request: AuthenticatedRequest,
    @Param() params: AttachmentIdParamDto,
  ): Promise<StreamableFile> {
    const result = await this.attachments.download(
      request.principal,
      request.tenantContext,
      params.attachmentId,
    );
    return new StreamableFile(result.body, {
      type: result.metadata.mediaType,
      length: Number(result.metadata.sizeBytes),
      disposition: contentDisposition(result.metadata.originalFilename),
    });
  }

  @Get(':attachmentId')
  @ApiOperation({
    operationId: 'attachments.getMetadata',
    summary: 'Get active attachment metadata',
    description:
      'Returns only safe metadata after Store, Owner, attachment, and parent authorization. READ_ONLY Store Owners may read.',
  })
  @ApiOkResponse({ type: AttachmentMetadataResponseDto })
  @ApiNotFoundResponse({ description: 'Attachment is missing, removed, or unauthorized.' })
  getMetadata(
    @Req() request: AuthenticatedRequest,
    @Param() params: AttachmentIdParamDto,
  ): Promise<AttachmentMetadataResponseDto> {
    return this.attachments.getMetadata(
      request.principal,
      request.tenantContext,
      params.attachmentId,
    );
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'attachments.remove',
    summary: 'Logically remove an attachment',
    description:
      'Owner-only business write. The binary becomes inaccessible immediately and purge-eligible after 30 days; the metadata tombstone remains for at least seven years. READ_ONLY Stores cannot remove.',
  })
  @ApiOkResponse({ type: AttachmentMetadataResponseDto })
  @ApiNotFoundResponse({ description: 'Attachment is missing, removed, or unauthorized.' })
  remove(
    @Req() request: AuthenticatedRequest,
    @Param() params: AttachmentIdParamDto,
  ): Promise<AttachmentMetadataResponseDto> {
    return this.attachments.remove(request.principal, request.tenantContext, params.attachmentId);
  }
}

function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^A-Za-z0-9._ -]/gu, '_').replaceAll('"', '_');
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/gu,
    (value) => `%${value.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
