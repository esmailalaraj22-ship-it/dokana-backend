import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { inArray } from 'drizzle-orm';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import { products, productUnits } from '../src/database/schema';
import type { TenantTransactionContext } from '../src/database/database.types';
import { encodeProductCursor, productCursorScopeHash } from '../src/products/product-read-cursor';
import { prepareProductSearchScope } from '../src/products/product-read-query';
import { ProductReadRepository } from '../src/products/product-read.repository';
import type {
  ProductDetailResponse,
  ProductListResponse,
  ProductStatus,
} from '../src/products/product-read.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const fixture = {
  stores: {
    a: '55000000-0000-4000-8000-000000000001',
    b: '55000000-0000-4000-8000-000000000002',
    readOnly: '55000000-0000-4000-8000-000000000003',
    viewer: '55000000-0000-4000-8000-000000000004',
  },
  users: {
    a: '55100000-0000-4000-8000-000000000001',
    b: '55100000-0000-4000-8000-000000000002',
    readOnly: '55100000-0000-4000-8000-000000000003',
    viewer: '55100000-0000-4000-8000-000000000004',
  },
  memberships: {
    a: '55200000-0000-4000-8000-000000000001',
    b: '55200000-0000-4000-8000-000000000002',
    readOnly: '55200000-0000-4000-8000-000000000003',
    viewer: '55200000-0000-4000-8000-000000000004',
  },
  devices: {
    a: '55300000-0000-4000-8000-000000000001',
    b: '55300000-0000-4000-8000-000000000002',
    readOnly: '55300000-0000-4000-8000-000000000003',
    viewer: '55300000-0000-4000-8000-000000000004',
  },
  emails: {
    a: 'task53-a@example.test',
    b: 'task53-b@example.test',
    readOnly: 'task53-read-only@example.test',
    viewer: 'task53-viewer@example.test',
  },
  password: 'Task-5.3-Test-Password!',
  products: {
    aPinnedAlpha: '55400000-0000-4000-8000-000000000001',
    aPinnedZeta: '55400000-0000-4000-8000-000000000002',
    aSame1: '55400000-0000-4000-8000-000000000003',
    aSame2: '55400000-0000-4000-8000-000000000004',
    aArabic: '55400000-0000-4000-8000-000000000005',
    aPercent: '55400000-0000-4000-8000-000000000006',
    aUnderscore: '55400000-0000-4000-8000-000000000007',
    aIdentity: '55400000-0000-4000-8000-000000000008',
    aArchived: '55400000-0000-4000-8000-000000000009',
    aOther: '55400000-0000-4000-8000-000000000010',
    aBackslash: '55400000-0000-4000-8000-000000000011',
    bForeign: '55400000-0000-4000-8000-000000000101',
    readOnly: '55400000-0000-4000-8000-000000000201',
    viewer: '55400000-0000-4000-8000-000000000301',
  },
  units: {
    archivedBase: '55600000-0000-4000-8000-000000000001',
    archivedCase: '55600000-0000-4000-8000-000000000002',
    wrongProduct: '55600000-0000-4000-8000-000000000003',
    foreign: '55600000-0000-4000-8000-000000000101',
  },
};

interface AccessIdentity {
  accessToken: string;
  storeId: string;
  userId: string;
  deviceId: string;
}

interface ProductFixtureRecord {
  id: string;
  storeId: string;
  name: string;
  normalizedName: string;
  sku?: string;
  barcode?: string;
  description?: string;
  measurementType?: 'count' | 'weight' | 'volume' | 'length';
  isPinned?: boolean;
  status?: ProductStatus;
  lowStockThresholdMilli?: string;
  version?: string;
}

interface UnitFixtureRecord {
  id: string;
  storeId: string;
  productId: string;
  unitName: string;
  isBase: boolean;
  factorNum: number;
  factorDen: number;
  salePriceMinor?: string | null;
  purchasePriceMinor?: string | null;
  status?: ProductStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

class SynchronousLogCapture implements DestinationStream {
  private output = '';

  write(message: string): void {
    this.output += message;
  }

  clear(): void {
    this.output = '';
  }

  flush(): string {
    return this.output;
  }
}

function readList(response: Response): ProductListResponse {
  const body: unknown = response.body;
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error('Expected a Product list response.');
  }
  return body as unknown as ProductListResponse;
}

function readDetail(response: Response): ProductDetailResponse {
  const body: unknown = response.body;
  if (!isRecord(body) || !Array.isArray(body.units)) {
    throw new Error('Expected a Product detail response.');
  }
  return body as unknown as ProductDetailResponse;
}

function readAccessToken(response: Response): string {
  const body: unknown = response.body;
  if (!isRecord(body) || typeof body.accessToken !== 'string') {
    throw new Error('Expected an access token.');
  }
  return body.accessToken;
}

function withoutTraceFields(body: unknown): unknown {
  if (!isRecord(body)) {
    return body;
  }
  const stable = { ...body };
  delete stable.requestId;
  delete stable.timestamp;
  delete stable.path;
  return stable;
}

describe('Product read API with real PostgreSQL', () => {
  const logCapture = new SynchronousLogCapture();
  let app: INestApplication | undefined;
  let server: Server;
  let adminPool: Pool;
  let runtimeInspectionPool: Pool;
  let poolsInitialized = false;
  let access: Record<'a' | 'b' | 'readOnly' | 'viewer', AccessIdentity>;

  const storeIds = Object.values(fixture.stores);
  const userIds = Object.values(fixture.users);
  const membershipIds = Object.values(fixture.memberships);
  const productIds = Object.values(fixture.products);
  const unitIds = Object.values(fixture.units);

  const productRecords: ProductFixtureRecord[] = [
    {
      id: fixture.products.aPinnedAlpha,
      storeId: fixture.stores.a,
      name: 'Alpha Pinned',
      normalizedName: 'alpha pinned',
      isPinned: true,
    },
    {
      id: fixture.products.aPinnedZeta,
      storeId: fixture.stores.a,
      name: 'Zeta Pinned',
      normalizedName: 'zeta pinned',
      isPinned: true,
    },
    {
      id: fixture.products.aSame1,
      storeId: fixture.stores.a,
      name: 'Same Product One',
      normalizedName: 'same product',
    },
    {
      id: fixture.products.aSame2,
      storeId: fixture.stores.a,
      name: 'Same Product Two',
      normalizedName: 'same product',
    },
    {
      id: fixture.products.aArabic,
      storeId: fixture.stores.a,
      name: 'أرز مُمتاز',
      normalizedName: 'ارز ممتاز',
    },
    {
      id: fixture.products.aPercent,
      storeId: fixture.stores.a,
      name: 'Oil% Special',
      normalizedName: 'oil% special',
    },
    {
      id: fixture.products.aUnderscore,
      storeId: fixture.stores.a,
      name: 'Oil_ Special',
      normalizedName: 'oil_ special',
    },
    {
      id: fixture.products.aIdentity,
      storeId: fixture.stores.a,
      name: 'Identity Product',
      normalizedName: 'identity product',
      sku: 'ABC',
      barcode: '001234',
      description: 'Precision Product',
      lowStockThresholdMilli: '9007199254740993',
    },
    {
      id: fixture.products.aArchived,
      storeId: fixture.stores.a,
      name: 'Archived Product',
      normalizedName: 'archived product',
      description: 'Historical Product',
      status: 'archived',
    },
    {
      id: fixture.products.aOther,
      storeId: fixture.stores.a,
      name: 'Other Product',
      normalizedName: 'other product',
    },
    {
      id: fixture.products.aBackslash,
      storeId: fixture.stores.a,
      name: 'Oil\\ Special',
      normalizedName: 'oil\\ special',
    },
    {
      id: fixture.products.bForeign,
      storeId: fixture.stores.b,
      name: 'Foreign Product',
      normalizedName: 'foreign product',
      sku: 'ABC',
      barcode: '001234',
    },
    {
      id: fixture.products.readOnly,
      storeId: fixture.stores.readOnly,
      name: 'Read Only Product',
      normalizedName: 'read only product',
    },
    {
      id: fixture.products.viewer,
      storeId: fixture.stores.viewer,
      name: 'Viewer Product',
      normalizedName: 'viewer product',
    },
  ];

  const unitRecords: UnitFixtureRecord[] = [
    {
      id: fixture.units.archivedBase,
      storeId: fixture.stores.a,
      productId: fixture.products.aArchived,
      unitName: 'Base Piece',
      isBase: true,
      factorNum: 1,
      factorDen: 1,
      salePriceMinor: null,
      purchasePriceMinor: '0',
    },
    {
      id: fixture.units.archivedCase,
      storeId: fixture.stores.a,
      productId: fixture.products.aArchived,
      unitName: 'Case',
      isBase: false,
      factorNum: 2,
      factorDen: 4,
      salePriceMinor: '9007199254740993',
      purchasePriceMinor: null,
      status: 'archived',
    },
    {
      id: fixture.units.wrongProduct,
      storeId: fixture.stores.a,
      productId: fixture.products.aOther,
      unitName: 'Wrong Product Unit',
      isBase: true,
      factorNum: 1,
      factorDen: 1,
    },
    {
      id: fixture.units.foreign,
      storeId: fixture.stores.b,
      productId: fixture.products.bForeign,
      unitName: 'Foreign Unit',
      isBase: true,
      factorNum: 1,
      factorDen: 1,
    },
  ];

  async function removeFixtures(): Promise<void> {
    await adminPool.query(`delete from platform.auth_sessions where user_id = any($1::uuid[])`, [
      userIds,
    ]);
    await adminPool.query(`delete from ledger.product_units where id = any($1::uuid[])`, [unitIds]);
    await adminPool.query(`delete from ledger.products where id = any($1::uuid[])`, [productIds]);
    await adminPool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from sync.change_events where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from platform.store_memberships where id = any($1::uuid[])`, [
      membershipIds,
    ]);
    await adminPool.query(`delete from platform.users where id = any($1::uuid[])`, [userIds]);
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [storeIds]);
  }

  async function insertProduct(record: ProductFixtureRecord, index: number): Promise<void> {
    await adminPool.query(
      `
        insert into ledger.products (
          id, store_id, name, normalized_name, sku, barcode, description,
          measurement_type, low_stock_threshold_milli, is_pinned, status,
          archived_at, operation_id, version
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10, $11,
          case when $11 = 'archived' then '2026-08-01T00:00:00Z'::timestamptz else null end,
          $12, $13::bigint
        )
      `,
      [
        record.id,
        record.storeId,
        record.name,
        record.normalizedName,
        record.sku ?? null,
        record.barcode ?? null,
        record.description ?? null,
        record.measurementType ?? 'count',
        record.lowStockThresholdMilli ?? null,
        record.isPinned ?? false,
        record.status ?? 'active',
        `55500000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
        record.version ?? '1',
      ],
    );
  }

  async function insertUnit(record: UnitFixtureRecord, index: number): Promise<void> {
    await adminPool.query(
      `
        insert into ledger.product_units (
          id, store_id, product_id, measurement_type, unit_name, is_base,
          factor_num, factor_den, sale_price_minor, purchase_price_minor,
          status, operation_id
        )
        values ($1, $2, $3, 'count', $4, $5, $6, $7, $8::bigint, $9::bigint, $10, $11)
      `,
      [
        record.id,
        record.storeId,
        record.productId,
        record.unitName,
        record.isBase,
        record.factorNum,
        record.factorDen,
        record.salePriceMinor ?? null,
        record.purchasePriceMinor ?? null,
        record.status ?? 'active',
        `55700000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      ],
    );
  }

  async function login(
    key: keyof typeof fixture.emails,
    storeId: string,
    userId: string,
    deviceId: string,
    email: string,
  ): Promise<AccessIdentity> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email,
        password: fixture.password,
        storeId,
        deviceId,
        deviceName: `Task 5.3 ${key} device`,
        devicePlatform: 'android',
      })
      .expect(200);
    return { accessToken: readAccessToken(response), storeId, userId, deviceId };
  }

  function authorizedGet(identity: AccessIdentity, path: string) {
    return request(server).get(path).set('authorization', `Bearer ${identity.accessToken}`);
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL test environment is unavailable.');
    }
    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'info';
    process.env.DATABASE_URL = environment.runtimeUrl;
    process.env.AUTH_DATABASE_URL = environment.authUrl;

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-task53-admin',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimeInspectionPool = createTestPool(
      environment.runtimeUrl,
      'dokana-task53-runtime-inspection',
      1,
    );
    poolsInitialized = true;

    const approvedDatabase = await adminPool.query<{ databaseName: string; isSuperuser: boolean }>(`
      select current_database() as "databaseName", role_state.rolsuper as "isSuperuser"
      from pg_roles as role_state where role_state.rolname = current_user
    `);
    if (
      approvedDatabase.rows[0]?.databaseName !== environment.databaseName ||
      !approvedDatabase.rows[0].isSuperuser
    ) {
      throw new Error('The local Product fixture database is not approved.');
    }

    await removeFixtures();
    const passwordHash = await new PasswordService().hash(fixture.password);
    await adminPool.query(
      `
        insert into ledger.stores (id, name, status)
        values
          ($1, 'Task 5.3 Store A', 'active'),
          ($2, 'Task 5.3 Store B', 'active'),
          ($3, 'Task 5.3 Read Only', 'read_only'),
          ($4, 'Task 5.3 Viewer', 'active')
      `,
      storeIds,
    );
    await adminPool.query(
      `
        insert into platform.users (
          id, email, normalized_email, password_hash, full_name, status
        )
        values
          ($1, $2, $2, $9, 'Task 5.3 Owner A', 'active'),
          ($3, $4, $4, $9, 'Task 5.3 Owner B', 'active'),
          ($5, $6, $6, $9, 'Task 5.3 Read Only Owner', 'active'),
          ($7, $8, $8, $9, 'Task 5.3 Viewer', 'active')
      `,
      [
        fixture.users.a,
        fixture.emails.a,
        fixture.users.b,
        fixture.emails.b,
        fixture.users.readOnly,
        fixture.emails.readOnly,
        fixture.users.viewer,
        fixture.emails.viewer,
        passwordHash,
      ],
    );
    await adminPool.query(
      `
        insert into platform.store_memberships (id, store_id, user_id, role, status)
        values
          ($1, $2, $3, 'owner', 'active'),
          ($4, $5, $6, 'owner', 'active'),
          ($7, $8, $9, 'owner', 'active'),
          ($10, $11, $12, 'viewer', 'active')
      `,
      [
        fixture.memberships.a,
        fixture.stores.a,
        fixture.users.a,
        fixture.memberships.b,
        fixture.stores.b,
        fixture.users.b,
        fixture.memberships.readOnly,
        fixture.stores.readOnly,
        fixture.users.readOnly,
        fixture.memberships.viewer,
        fixture.stores.viewer,
        fixture.users.viewer,
      ],
    );
    for (const [index, product] of productRecords.entries()) {
      await insertProduct(product, index + 1);
    }
    for (const [index, unit] of unitRecords.entries()) {
      await insertUnit(unit, index + 1);
    }

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useFactory({
        factory: (config: AppConfigService) => createLoggingParams(config, logCapture),
        inject: [AppConfigService],
      })
      .compile();
    const nestApp = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    nestApp.useLogger(nestApp.get(Logger));
    configureApplication(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp;
    server = nestApp.getHttpServer();

    access = {
      a: await login('a', fixture.stores.a, fixture.users.a, fixture.devices.a, fixture.emails.a),
      b: await login('b', fixture.stores.b, fixture.users.b, fixture.devices.b, fixture.emails.b),
      readOnly: await login(
        'readOnly',
        fixture.stores.readOnly,
        fixture.users.readOnly,
        fixture.devices.readOnly,
        fixture.emails.readOnly,
      ),
      viewer: await login(
        'viewer',
        fixture.stores.viewer,
        fixture.users.viewer,
        fixture.devices.viewer,
        fixture.emails.viewer,
      ),
    };
  }, 60_000);

  beforeEach(() => {
    logCapture.clear();
  });

  afterAll(async () => {
    await app?.close();
    if (!poolsInitialized) {
      return;
    }
    await removeFixtures();
    const residue = await adminPool.query<{ count: number }>(
      `
        select (
          (select count(*) from ledger.stores where id = any($1::uuid[]))
          + (select count(*) from platform.users where id = any($2::uuid[]))
          + (select count(*) from platform.store_memberships where id = any($3::uuid[]))
          + (select count(*) from ledger.devices where store_id = any($1::uuid[]))
          + (select count(*) from ledger.products where id = any($4::uuid[]))
          + (select count(*) from ledger.product_units where id = any($5::uuid[]))
          + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
        )::integer as count
      `,
      [storeIds, userIds, membershipIds, productIds, unitIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimeInspectionPool.end(), adminPool.end()]);
  }, 30_000);

  it('requires authentication and owner authority while allowing read-only owner reads', async () => {
    await request(server).get('/v1/products').expect(401);
    await authorizedGet(access.viewer, '/v1/products')
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'PRODUCT_READ_NOT_ALLOWED' });
      });

    const readOnly = readList(await authorizedGet(access.readOnly, '/v1/products').expect(200));
    expect(readOnly.items.map((item) => item.id)).toEqual([fixture.products.readOnly]);
  });

  it('validates scalar query grammar, duplicate parameters, and Product UUIDs strictly', async () => {
    for (const query of [
      { status: 'all' },
      { limit: '0' },
      { limit: '101' },
      { limit: '01' },
      { limit: '+10' },
      { limit: '10.0' },
      { limit: '1e2' },
      { limit: ' 10 ' },
      { unexpected: 'value' },
      { storeId: fixture.stores.b },
    ]) {
      await authorizedGet(access.a, '/v1/products').query(query).expect(400);
    }
    for (const path of [
      '/v1/products?search=a&search=a',
      '/v1/products?status=active&status=active',
      '/v1/products?limit=10&limit=10',
      '/v1/products?cursor=x&cursor=x',
    ]) {
      await authorizedGet(access.a, path).expect(400);
    }
    await authorizedGet(access.a, '/v1/products/not-a-uuid').expect(400);
  });

  it('orders active Products by pin, normalized name, and UUID without tenant leakage', async () => {
    const response = readList(await authorizedGet(access.a, '/v1/products').expect(200));
    expect(response.items.slice(0, 2).map((item) => item.id)).toEqual([
      fixture.products.aPinnedAlpha,
      fixture.products.aPinnedZeta,
    ]);
    expect(
      response.items.filter((item) => item.name.startsWith('Same Product')).map((item) => item.id),
    ).toEqual([fixture.products.aSame1, fixture.products.aSame2]);
    expect(response.items.map((item) => item.id)).not.toContain(fixture.products.aArchived);
    expect(response.items.map((item) => item.id)).not.toContain(fixture.products.bForeign);
    for (const item of response.items) {
      expect(Object.keys(item).sort()).toEqual([
        'allowNegativeStockOverride',
        'archivedAt',
        'barcode',
        'id',
        'isPinned',
        'lowStockThresholdMilli',
        'measurementType',
        'name',
        'sku',
        'status',
        'trackInventory',
        'updatedAt',
        'version',
      ]);
    }
  });

  it('supports explicit archived listing and exact same-store archived detail', async () => {
    const archived = readList(
      await authorizedGet(access.a, '/v1/products').query({ status: 'archived' }).expect(200),
    );
    expect(archived.items.map((item) => item.id)).toEqual([fixture.products.aArchived]);

    const detail = readDetail(
      await authorizedGet(access.a, `/v1/products/${fixture.products.aArchived}`).expect(200),
    );
    expect(detail).toMatchObject({
      id: fixture.products.aArchived,
      status: 'archived',
      description: 'Historical Product',
      units: [
        {
          id: fixture.units.archivedBase,
          status: 'active',
          salePriceMinor: null,
          purchasePriceMinor: '0',
          factorNum: 1,
          factorDen: 1,
        },
        {
          id: fixture.units.archivedCase,
          status: 'archived',
          salePriceMinor: '9007199254740993',
          purchasePriceMinor: null,
          factorNum: 2,
          factorDen: 4,
        },
      ],
    });
    expect(detail.units.map((unit) => unit.id)).not.toContain(fixture.units.wrongProduct);
    expect(detail.units.map((unit) => unit.id)).not.toContain(fixture.units.foreign);
  });

  it('implements normalized literal-prefix name or exact SKU or exact barcode search', async () => {
    for (const search of ['  ٱرْز  ', 'أرز']) {
      const result = readList(
        await authorizedGet(access.a, '/v1/products').query({ search }).expect(200),
      );
      expect(result.items.map((item) => item.id)).toEqual([fixture.products.aArabic]);
    }

    const exactSku = readList(
      await authorizedGet(access.a, '/v1/products').query({ search: 'ABC' }).expect(200),
    );
    const wrongSkuCase = readList(
      await authorizedGet(access.a, '/v1/products').query({ search: 'abc' }).expect(200),
    );
    const exactBarcode = readList(
      await authorizedGet(access.a, '/v1/products').query({ search: '001234' }).expect(200),
    );
    const coercedBarcode = readList(
      await authorizedGet(access.a, '/v1/products').query({ search: '1234' }).expect(200),
    );
    expect(exactSku.items.map((item) => item.id)).toEqual([fixture.products.aIdentity]);
    expect(wrongSkuCase.items).toEqual([]);
    expect(exactBarcode.items.map((item) => item.id)).toEqual([fixture.products.aIdentity]);
    expect(coercedBarcode.items).toEqual([]);

    const percent = readList(
      await authorizedGet(access.a, '/v1/products').query({ search: 'Oil%' }).expect(200),
    );
    const underscore = readList(
      await authorizedGet(access.a, '/v1/products').query({ search: 'Oil_' }).expect(200),
    );
    const backslash = readList(
      await authorizedGet(access.a, '/v1/products').query({ search: 'Oil\\' }).expect(200),
    );
    expect(percent.items.map((item) => item.id)).toEqual([fixture.products.aPercent]);
    expect(underscore.items.map((item) => item.id)).toEqual([fixture.products.aUnderscore]);
    expect(backslash.items.map((item) => item.id)).toEqual([fixture.products.aBackslash]);

    for (const search of ['', ' \u00a0 ', '\u0640\u064b']) {
      await authorizedGet(access.a, '/v1/products').query({ search }).expect(400);
    }
  });

  it('paginates the exact total order without duplicates and binds cursor scope', async () => {
    const complete = readList(await authorizedGet(access.a, '/v1/products').expect(200));
    const pagedIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = readList(
        await authorizedGet(access.a, '/v1/products')
          .query({ limit: 2, ...(cursor ? { cursor } : {}) })
          .expect(200),
      );
      pagedIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pagedIds).toEqual(complete.items.map((item) => item.id));
    expect(new Set(pagedIds).size).toBe(pagedIds.length);

    const first = readList(
      await authorizedGet(access.a, '/v1/products').query({ limit: 1 }).expect(200),
    );
    if (!first.nextCursor) {
      throw new Error('Expected a Product continuation cursor.');
    }
    await authorizedGet(access.a, '/v1/products')
      .query({ status: 'archived', limit: 1, cursor: first.nextCursor })
      .expect(400);
    await authorizedGet(access.a, '/v1/products')
      .query({ search: 'Alpha', limit: 1, cursor: first.nextCursor })
      .expect(400);
    for (const path of [
      '/v1/products?cursor',
      '/v1/products?cursor=',
      '/v1/products?cursor=%20',
      '/v1/products?cursor=not-valid',
    ]) {
      await authorizedGet(access.a, path).expect(400);
    }
  });

  it('rejects missing, foreign, modified, or out-of-scope cursor anchors non-disclosingly', async () => {
    const scopeHash = productCursorScopeHash('active', null);
    const missingCursor = encodeProductCursor({
      scopeHash,
      anchor: { id: randomUUID(), version: 1n },
    });
    const foreignCursor = encodeProductCursor({
      scopeHash,
      anchor: { id: fixture.products.bForeign, version: 1n },
    });
    const missing = await authorizedGet(access.a, '/v1/products')
      .query({ cursor: missingCursor })
      .expect(400);
    const foreign = await authorizedGet(access.a, '/v1/products')
      .query({ cursor: foreignCursor })
      .expect(400);
    expect(withoutTraceFields(foreign.body)).toEqual(withoutTraceFields(missing.body));

    const changedCursor = encodeProductCursor({
      scopeHash,
      anchor: { id: fixture.products.aPinnedAlpha, version: 1n },
    });
    await adminPool.query(`update ledger.products set version = 2 where id = $1`, [
      fixture.products.aPinnedAlpha,
    ]);
    await authorizedGet(access.a, '/v1/products').query({ cursor: changedCursor }).expect(400);
    await adminPool.query(`update ledger.products set version = 1 where id = $1`, [
      fixture.products.aPinnedAlpha,
    ]);

    const alphaSearch = prepareProductSearchScope('Alpha');
    if (!alphaSearch) {
      throw new Error('Expected an Alpha Product search scope.');
    }
    const outOfScopeCursor = encodeProductCursor({
      scopeHash: productCursorScopeHash('active', alphaSearch),
      anchor: { id: fixture.products.aPinnedAlpha, version: 1n },
    });
    await adminPool.query(
      `update ledger.products set name = 'Moved', normalized_name = 'moved' where id = $1`,
      [fixture.products.aPinnedAlpha],
    );
    await authorizedGet(access.a, '/v1/products')
      .query({ search: 'Alpha', cursor: outOfScopeCursor })
      .expect(400);
    await adminPool.query(
      `update ledger.products set name = 'Alpha Pinned', normalized_name = 'alpha pinned' where id = $1`,
      [fixture.products.aPinnedAlpha],
    );
  });

  it('makes foreign Product detail indistinguishable from absence and ignores forged tenant input', async () => {
    const nonexistent = await authorizedGet(access.a, `/v1/products/${randomUUID()}`).expect(404);
    const foreign = await authorizedGet(
      access.a,
      `/v1/products/${fixture.products.bForeign}`,
    ).expect(404);
    expect(withoutTraceFields(foreign.body)).toEqual(withoutTraceFields(nonexistent.body));

    const forged = readList(
      await authorizedGet(access.a, '/v1/products')
        .set('x-store-id', fixture.stores.b)
        .query({ search: 'ABC' })
        .expect(200),
    );
    expect(forged.items.map((item) => item.id)).toEqual([fixture.products.aIdentity]);
    await authorizedGet(access.a, '/v1/products').query({ storeId: fixture.stores.b }).expect(400);
  });

  it('uses least-privileged forced RLS, fails closed, and does not leak query values to logs', async () => {
    if (!app || !environment) {
      throw new Error('The Product integration application is unavailable.');
    }
    const runtimeState = await runtimeInspectionPool.query<{
      currentUser: string;
      isSuperuser: boolean;
      bypassesRls: boolean;
      rowSecurityEnabled: boolean;
      runtimeMember: boolean;
      ownsProducts: boolean;
      ownsUnits: boolean;
    }>(`
      select
        current_user as "currentUser",
        role_state.rolsuper as "isSuperuser",
        role_state.rolbypassrls as "bypassesRls",
        current_setting('row_security') = 'on' as "rowSecurityEnabled",
        pg_has_role(current_user, 'shop_app_runtime', 'MEMBER') as "runtimeMember",
        pg_get_userbyid(product_table.relowner) = current_user as "ownsProducts",
        pg_get_userbyid(unit_table.relowner) = current_user as "ownsUnits"
      from pg_roles as role_state
      cross join pg_class as product_table
      cross join pg_class as unit_table
      where role_state.rolname = current_user
        and product_table.oid = 'ledger.products'::regclass
        and unit_table.oid = 'ledger.product_units'::regclass
    `);
    expect(runtimeState.rows[0]).toEqual({
      currentUser: decodeURIComponent(new URL(environment.runtimeUrl).username),
      isSuperuser: false,
      bypassesRls: false,
      rowSecurityEnabled: true,
      runtimeMember: true,
      ownsProducts: false,
      ownsUnits: false,
    });
    const noContext = await runtimeInspectionPool.query<{ products: number; units: number }>(
      `
      select
        (select count(*)::integer from ledger.products where id = any($1::uuid[])) as products,
        (select count(*)::integer from ledger.product_units where id = any($2::uuid[])) as units
    `,
      [productIds, unitIds],
    );
    expect(noContext.rows[0]).toEqual({ products: 0, units: 0 });

    const database = app.get(DatabaseService);
    const contextA: TenantTransactionContext = {
      storeId: access.a.storeId,
      userId: access.a.userId,
      deviceId: access.a.deviceId,
      requestId: randomUUID(),
    };
    const visibleA = await database.withTenantTransaction(contextA, (transaction) =>
      transaction
        .select({ id: products.id })
        .from(products)
        .where(inArray(products.id, [fixture.products.aIdentity, fixture.products.bForeign])),
    );
    expect(visibleA).toEqual([{ id: fixture.products.aIdentity }]);
    const visibleUnits = await database.withTenantTransaction(contextA, (transaction) =>
      transaction
        .select({ id: productUnits.id })
        .from(productUnits)
        .where(inArray(productUnits.id, [fixture.units.archivedBase, fixture.units.foreign])),
    );
    expect(visibleUnits).toEqual([{ id: fixture.units.archivedBase }]);

    const repository = app.get(ProductReadRepository);
    await expect(
      repository.list(undefined as unknown as TenantTransactionContext, {
        status: 'active',
        search: null,
        anchor: null,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(TypeError);

    const privateSearch = 'PRIVATE-PRODUCT-SEARCH-53';
    await authorizedGet(access.a, '/v1/products').query({ search: privateSearch }).expect(200);
    const privateCursor = encodeProductCursor({
      scopeHash: productCursorScopeHash('active', null),
      anchor: { id: randomUUID(), version: 1n },
    });
    await authorizedGet(access.a, '/v1/products').query({ cursor: privateCursor }).expect(400);
    const logs = logCapture.flush();
    expect(logs).not.toContain(privateSearch);
    expect(logs).not.toContain(privateCursor);
    expect(logs).not.toContain(`search=${privateSearch}`);
    expect(logs).not.toContain('?search=');
    expect(logs).not.toContain('?cursor=');
  });
});
