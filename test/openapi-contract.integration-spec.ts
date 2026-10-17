import type { Server } from 'node:http';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type {
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  ReferenceObject,
  ResponseObject,
  SchemaObject,
} from '@nestjs/swagger';
import request from 'supertest';

import {
  configureOpenApi,
  createDokanaOpenApiDocument,
  OPENAPI_JSON_PATH,
} from '../src/api-contract/openapi';
import { S20_SCHEMA_NAMES } from '../src/api-contract/s20-openapi.schemas';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';

const httpMethods = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const;
type HttpMethod = (typeof httpMethods)[number];

const reportPaths = [
  'daily',
  'monthly',
  'profit',
  'sales',
  'expenses',
  'money-movements',
  'liquidity',
  'customer-receivables',
  'supplier-payables',
  'inventory-stock',
  'inventory-movements',
  'returns-corrections',
  'owner-ledger',
] as const;

const pdfPaths = [
  '/v1/documents/sales/{saleId}.pdf',
  '/v1/documents/customers/{customerId}/ledger.pdf',
  '/v1/documents/suppliers/{supplierId}/ledger.pdf',
  ...reportPaths.map((path) => `/v1/documents/reports/${path}.pdf`),
] as const;

describe('machine-readable Dokana API contract', () => {
  let app: NestExpressApplication;
  let document: OpenAPIObject;
  let server: Server;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      bodyParser: false,
      logger: false,
    });
    configureApplication(app, app.get(AppConfigService));
    document = configureOpenApi(app);
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves deterministic OpenAPI JSON without enabling an interactive documentation UI', async () => {
    const regenerated = createDokanaOpenApiDocument(app);
    expect(regenerated.paths).toEqual(document.paths);

    const response = await request(server).get(OPENAPI_JSON_PATH).expect(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.text).toContain(`"openapi":"${document.openapi}"`);
    expect(response.text).toContain('"title":"Dokana Backend API"');
    expect(response.text).toContain('"version":"1.0.0"');
    await request(server).get('/api-contract').expect(404);
  });

  it('covers the current public route surface and gives every operation a unique identifier', () => {
    const operations = allOperations(document);
    const operationIds = operations.map(({ operation }) => operation.operationId);

    expect(Object.keys(document.paths).length).toBeGreaterThan(100);
    expect(document.paths).toHaveProperty('/v1/auth/login');
    expect(document.paths).toHaveProperty('/v1/customers');
    expect(document.paths).toHaveProperty('/v1/sync/pull');
    expect(document.paths).toHaveProperty('/v1/admin/stores');
    expect(operationIds.every((operationId) => typeof operationId === 'string')).toBe(true);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(Object.keys(document.paths).some((path) => path.includes('openapi'))).toBe(false);
  });

  it('documents every S20 JSON and PDF operation with bearer security and stable errors', () => {
    const jsonPaths = [
      '/v1/dashboard',
      '/v1/search',
      ...reportPaths.map((path) => `/v1/reports/${path}`),
    ];
    for (const path of jsonPaths) {
      const operation = operationAt(document, path, 'get');
      expect(operation.security).toContainEqual({ bearer: [] });
      expect(operation.responses).toHaveProperty('200');
      expect(operation.responses).toHaveProperty('401');
      expect(operation.responses).toHaveProperty('403');
    }
    for (const path of ['/v1/search', ...jsonPaths.filter((path) => path.includes('/reports/'))]) {
      expect(operationAt(document, path, 'get').responses).toHaveProperty('400');
    }

    for (const path of pdfPaths) {
      const operation = operationAt(document, path, 'get');
      const response = responseAt(operation, '200');
      expect(operation.security).toContainEqual({ bearer: [] });
      expect(response.content?.['application/pdf']?.schema).toEqual({
        type: 'string',
        format: 'binary',
      });
      expect(operation.responses).toMatchObject({ '400': {}, '401': {}, '403': {}, '404': {} });
    }
  });

  it('documents required queries, enums, keyset cursors, and canonical resource identifiers', () => {
    const sales = parameters(operationAt(document, '/v1/reports/sales', 'get'));
    expect(parameter(sales, 'fromDate')).toMatchObject({
      required: true,
      schema: { format: 'date' },
    });
    expect(parameter(sales, 'toDate')).toMatchObject({
      required: true,
      schema: { format: 'date' },
    });
    expect(parameter(sales, 'limit')).toMatchObject({
      required: false,
      schema: { minimum: 1, maximum: 100, default: 50 },
    });
    expect(parameter(sales, 'cursor')).toMatchObject({
      required: false,
      schema: { maxLength: 192 },
    });
    expect(parameter(sales, 'status').schema).toMatchObject({
      enum: ['posted', 'cancelled', 'corrected', 'all'],
    });

    const search = parameters(operationAt(document, '/v1/search', 'get'));
    expect(parameter(search, 'q')).toMatchObject({ required: true, schema: { maxLength: 256 } });
    expect(parameterSchema(parameter(search, 'type')).enum).toContain('sale');
    expect(parameter(search, 'limit').schema).toMatchObject({
      minimum: 1,
      maximum: 50,
      default: 25,
    });
    expect(parameter(search, 'cursor').schema).toMatchObject({ maxLength: 256 });

    const salePdf = parameters(operationAt(document, '/v1/documents/sales/{saleId}.pdf', 'get'));
    expect(parameter(salePdf, 'saleId')).toMatchObject({
      in: 'path',
      required: true,
      schema: { format: 'uuid' },
    });
  });

  it('provides resolvable S20 response schemas and an exact client data dictionary', () => {
    const schemas = document.components?.schemas;
    if (!schemas) throw new Error('OpenAPI component schemas are missing.');

    expect(responseRef(operationAt(document, '/v1/dashboard', 'get'))).toBe(
      `#/components/schemas/${S20_SCHEMA_NAMES.dashboard}`,
    );
    expect(responseRef(operationAt(document, '/v1/reports/profit', 'get'))).toBe(
      `#/components/schemas/${S20_SCHEMA_NAMES.profit}`,
    );
    expect(responseRef(operationAt(document, '/v1/search', 'get'))).toBe(
      `#/components/schemas/${S20_SCHEMA_NAMES.search}`,
    );

    const salesRow = schemaAt(document, 'SalesReportRow');
    const totalMinor = schemaProperty(salesRow, 'totalMinor');
    expect(totalMinor).toMatchObject({
      type: 'string',
      pattern: '^-?[0-9]+$',
    });
    expect(totalMinor.description).toContain('floating-point');
    const salesBusinessDate = schemaProperty(salesRow, 'businessDate');
    expect(salesBusinessDate).toMatchObject({
      format: 'date',
    });
    expect(salesBusinessDate.description).toContain('Store-local');
    const salesPostingDate = schemaProperty(salesRow, 'postingDate');
    expect(salesPostingDate).toMatchObject({
      format: 'date',
    });
    expect(salesPostingDate.description).toContain('server-side');
    const salesOccurredAt = schemaProperty(salesRow, 'occurredAt');
    expect(salesOccurredAt).toMatchObject({
      format: 'date-time',
    });
    expect(salesOccurredAt.description).toContain('chronology');
    expect(schemaProperty(salesRow, 'accountingPeriodId')).toMatchObject({
      format: 'uuid',
      nullable: true,
    });

    const movement = schemaAt(document, 'InventoryMovementReportRow');
    const movementQuantity = schemaProperty(movement, 'quantityDeltaMilli');
    expect(movementQuantity).toMatchObject({
      type: 'string',
      pattern: '^-?[0-9]+$',
    });
    expect(movementQuantity.description).toContain('milli-units');
    const stock = schemaAt(document, 'InventoryStockReportRow');
    const averageCost = schemaProperty(stock, 'averageUnitCostMinor');
    expect(averageCost).toMatchObject({
      type: 'string',
      nullable: true,
    });
    expect(averageCost.description).toContain('unknown/pending');
    const stockVersion = schemaProperty(stock, 'version');
    expect(stockVersion).toMatchObject({
      type: 'string',
      pattern: '^[0-9]+$',
    });
    expect(stockVersion.description).toContain('optimistic-concurrency');

    const profit = schemaAt(document, S20_SCHEMA_NAMES.profit);
    const profitMinor = schemaProperty(profit, 'profitMinor');
    expect(profitMinor).toMatchObject({
      type: 'string',
      nullable: true,
    });
    expect(profitMinor.description).toContain('not a statutory Profit and Loss statement');

    for (const schema of Object.values(schemas)) {
      for (const reference of collectReferences(schema)) {
        expect(reference).toMatch(/^#\/components\/schemas\//);
        expect(schemas).toHaveProperty(reference.replace('#/components/schemas/', ''));
      }
    }
    expect(() => JSON.stringify(document)).not.toThrow();
  });

  it('documents the bounded owner notification surface and exact money settings', () => {
    const list = operationAt(document, '/v1/notifications', 'get');
    const readState = operationAt(
      document,
      '/v1/notifications/{notificationId}/read-state',
      'patch',
    );
    const readSettings = operationAt(document, '/v1/notifications/settings', 'get');
    const updateSettings = operationAt(document, '/v1/notifications/settings', 'patch');

    for (const operation of [list, readState, readSettings, updateSettings]) {
      expect(operation.security).toContainEqual({ bearer: [] });
      expect(operation.responses).toHaveProperty('200');
      expect(operation.responses).toHaveProperty('401');
      expect(operation.responses).toHaveProperty('403');
    }
    expect(list.responses).toHaveProperty('400');
    expect(readState.responses).toHaveProperty('404');
    expect(updateSettings.responses).toHaveProperty('400');

    const listParameters = parameters(list);
    expect(parameter(listParameters, 'lifecycle').schema).toMatchObject({
      enum: ['active', 'resolved'],
    });
    expect(parameter(listParameters, 'read').schema).toMatchObject({ enum: ['true', 'false'] });
    expect(parameter(listParameters, 'limit').schema).toMatchObject({ minimum: 1, maximum: 100 });
    expect(parameter(listParameters, 'cursor').schema).toMatchObject({ maxLength: 768 });
    expect(parameter(parameters(readState), 'notificationId')).toMatchObject({
      in: 'path',
      required: true,
      schema: { format: 'uuid' },
    });

    expect(responseRef(list)).toBe('#/components/schemas/NotificationListResponseDto');
    expect(responseRef(readState)).toBe('#/components/schemas/NotificationReadStateResponseDto');
    expect(responseRef(readSettings)).toBe('#/components/schemas/NotificationSettingsResponseDto');
    expect(responseRef(updateSettings)).toBe(
      '#/components/schemas/NotificationSettingsMutationResponseDto',
    );
    expect(
      schemaProperty(
        schemaAt(document, 'NotificationSettingsResponseDto'),
        'customerDebtAmountAlertMinor',
      ),
    ).toMatchObject({
      type: 'string',
      pattern: '^(0|[1-9][0-9]*)$',
    });
  });
});

function allOperations(
  document: OpenAPIObject,
): { path: string; method: HttpMethod; operation: OperationObject }[] {
  const result: { path: string; method: HttpMethod; operation: OperationObject }[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of httpMethods) {
      const operation = item[method];
      if (operation) result.push({ path, method, operation });
    }
  }
  return result;
}

function operationAt(document: OpenAPIObject, path: string, method: HttpMethod): OperationObject {
  const operation = document.paths[path]?.[method];
  if (!operation) throw new Error(`Missing OpenAPI operation ${method.toUpperCase()} ${path}.`);
  return operation;
}

function responseAt(operation: OperationObject, status: string): ResponseObject {
  const response = operation.responses[status];
  if (!response || isReference(response)) throw new Error(`Missing inline ${status} response.`);
  return response;
}

function responseRef(operation: OperationObject): string {
  const schema = responseAt(operation, '200').content?.['application/json']?.schema;
  if (!schema || !isReference(schema))
    throw new Error('Expected a referenced JSON response schema.');
  return schema.$ref;
}

function parameters(operation: OperationObject): ParameterObject[] {
  return (operation.parameters ?? []).filter(
    (candidate): candidate is ParameterObject => !isReference(candidate),
  );
}

function parameter(parameters: ParameterObject[], name: string): ParameterObject {
  const result = parameters.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing OpenAPI parameter ${name}.`);
  return result;
}

function parameterSchema(parameter: ParameterObject): SchemaObject {
  const schema = parameter.schema;
  if (!schema || isReference(schema))
    throw new Error(`Missing inline schema for ${parameter.name}.`);
  return schema;
}

function schemaAt(document: OpenAPIObject, name: string): SchemaObject {
  const schema = document.components?.schemas?.[name];
  if (!schema || isReference(schema)) throw new Error(`Missing inline schema ${name}.`);
  return schema;
}

function schemaProperty(schema: SchemaObject, name: string): SchemaObject {
  const property = schema.properties?.[name];
  if (!property || isReference(property))
    throw new Error(`Missing inline schema property ${name}.`);
  return property;
}

function collectReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectReferences(item));
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.$ref === 'string' ? [record.$ref] : []),
    ...Object.values(record).flatMap((item) => collectReferences(item)),
  ];
}

function isReference(value: object): value is ReferenceObject {
  return '$ref' in value;
}
