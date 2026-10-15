import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

import { S20_COMPONENT_SCHEMAS } from './s20-openapi.schemas';

export const OPENAPI_JSON_PATH = '/openapi.json';

export function createDokanaOpenApiDocument(app: INestApplication): OpenAPIObject {
  const configuration = new DocumentBuilder()
    .setTitle('Dokana Backend API')
    .setDescription(
      'Machine-readable contract for the Dokana offline-first backend. Exact money and quantity semantics are defined on response schemas; authenticated Store operations derive tenant scope from the bearer token.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Dokana access token. Store identity and authorization are server-derived.',
      },
      'bearer',
    )
    .build();

  const document = SwaggerModule.createDocument(app, configuration, {
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey}.${methodKey}`,
  });
  document.components ??= {};
  document.components.schemas = {
    ...document.components.schemas,
    ...S20_COMPONENT_SCHEMAS,
  };
  return document;
}

export function configureOpenApi(app: INestApplication): OpenAPIObject {
  const document = createDokanaOpenApiDocument(app);
  SwaggerModule.setup('api-contract', app, document, {
    ui: false,
    raw: ['json'],
    jsonDocumentUrl: OPENAPI_JSON_PATH,
  });
  return document;
}
