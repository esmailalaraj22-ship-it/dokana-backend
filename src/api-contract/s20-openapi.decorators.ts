import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { S20_SCHEMA_NAMES, schemaReference } from './s20-openapi.schemas';

interface JsonOperationOptions {
  operationId: string;
  summary: string;
  description: string;
  schemaName: string;
  validation?: boolean;
}

interface PdfOperationOptions {
  operationId: string;
  summary: string;
  description: string;
}

const errorSchema = schemaReference(S20_SCHEMA_NAMES.error);

export function ApiS20JsonOperation(options: JsonOperationOptions): MethodDecorator {
  const decorators: MethodDecorator[] = [
    ApiOperation({
      operationId: options.operationId,
      summary: options.summary,
      description: options.description,
    }),
    ApiOkResponse({
      description: 'Successful, Store-scoped canonical read.',
      schema: schemaReference(options.schemaName),
    }),
    ApiUnauthorizedResponse({
      description: 'Missing or invalid bearer token.',
      schema: errorSchema,
    }),
    ApiForbiddenResponse({
      description: 'Authenticated actor is not authorized for this read.',
      schema: errorSchema,
    }),
  ];
  if (options.validation) {
    decorators.push(
      ApiBadRequestResponse({
        description: 'Query or cursor validation failed.',
        schema: errorSchema,
      }),
    );
  }
  return applyDecorators(...decorators);
}

export function ApiS20PdfOperation(options: PdfOperationOptions): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      operationId: options.operationId,
      summary: options.summary,
      description: options.description,
    }),
    ApiProduces('application/pdf'),
    ApiOkResponse({
      description:
        'Read-only canonical PDF. Content-Disposition is attachment with a deterministic safe filename.',
      content: {
        'application/pdf': {
          schema: { type: 'string', format: 'binary' },
        },
      },
    }),
    ApiBadRequestResponse({ description: 'Path/query validation failed.', schema: errorSchema }),
    ApiUnauthorizedResponse({
      description: 'Missing or invalid bearer token.',
      schema: errorSchema,
    }),
    ApiForbiddenResponse({
      description: 'Authenticated actor is not authorized for the source read.',
      schema: errorSchema,
    }),
    ApiNotFoundResponse({
      description: 'The requested source is unavailable in the authenticated Store scope.',
      schema: errorSchema,
    }),
  );
}
