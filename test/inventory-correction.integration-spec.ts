import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';

import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import { DatabaseService } from '../src/database/database.service';
import { InventoryCorrectionRepository } from '../src/inventory/inventory-correction.repository';
import { parseInventoryCorrectionCommand } from '../src/inventory/inventory-correction-command';
import type { InventoryCorrectionResponse } from '../src/inventory/inventory-correction-response';
import type { InventoryPostingResponse } from '../src/inventory/inventory-posting-response';
import {
  createInventoryTestDatabase,
  stockCountMigrationFilename,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

type Role = 'owner' | 'manager';
interface Identity {
  role: Role;
  storeId: string;
  userId: string;
  deviceId: string;
  email: string;
  token: string;
}
interface ProductFixture {
  productId: string;
  baseUnitId: string;
}

const owner: Identity = {
  role: 'owner',
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s116-${randomUUID()}@example.test`,
  token: '',
};
const manager: Identity = {
  role: 'manager',
  storeId: owner.storeId,
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s116-${randomUUID()}@example.test`,
  token: '',
};
const foreignOwner: Identity = {
  role: 'owner',
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s116-${randomUUID()}@example.test`,
  token: '',
};
const identities = [owner, manager, foreignOwner];
const january = '2026-01-15T10:00:00Z';

describe('S11.6 inventory corrections on isolated real PostgreSQL', () => {
  jest.setTimeout(180000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated inventory correction database is unavailable.');
    return database;
  }

  function postInventory(
    kind: 'opening' | 'increase' | 'decrease',
    body: unknown,
    identity = owner,
  ) {
    return request(server)
      .post(`/v1/inventory/${kind}`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body as object);
  }

  function postCount(body: unknown, identity = owner) {
    return request(server)
      .post('/v1/inventory/counts')
      .set('authorization', `Bearer ${identity.token}`)
      .send(body as object);
  }

  function postCorrection(body: unknown, identity = owner) {
    return request(server)
      .post('/v1/inventory/corrections')
      .set('authorization', `Bearer ${identity.token}`)
      .send(body as object);
  }

  function inventoryInput(product: ProductFixture, overrides: Record<string, unknown> = {}) {
    return {
      operationId: randomUUID(),
      productId: product.productId,
      productUnitId: product.baseUnitId,
      selectedQuantityMilli: '1000',
      occurredAt: january,
      ...overrides,
    };
  }

  function countInput(
    items: {
      productId: string;
      productUnitId: string;
      actualQuantityMilli: string;
    }[],
    overrides: Record<string, unknown> = {},
  ) {
    return {
      operationId: randomUUID(),
      countType: 'partial',
      occurredAt: january,
      items,
      ...overrides,
    };
  }

  function reversal(targetOperationId: string, overrides: Record<string, unknown> = {}) {
    return {
      operationId: randomUUID(),
      targetOperationId,
      correctionType: 'REVERSAL',
      occurredAt: january,
      ...overrides,
    };
  }

  function replacement(
    targetOperationId: string,
    family: 'opening' | 'increase' | 'decrease' | 'stock_count',
    payload: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      operationId: randomUUID(),
      targetOperationId,
      correctionType: 'REPLACEMENT',
      occurredAt: january,
      replacement: { family, ...payload },
      ...overrides,
    };
  }

  async function product(
    options: { storeId?: string; allowNegative?: boolean; tracked?: boolean } = {},
  ): Promise<ProductFixture> {
    const productId = randomUUID();
    const baseUnitId = randomUUID();
    const storeId = options.storeId ?? owner.storeId;
    await db().admin.query(
      `insert into ledger.products(
        id,store_id,name,normalized_name,track_inventory,measurement_type,
        allow_negative_stock_override,operation_id)
       values($1,$2,$3,$3,$4,'count',$5,$6)`,
      [
        productId,
        storeId,
        `s11.6-${productId}`,
        options.tracked ?? true,
        options.allowNegative ?? null,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.product_units(
        id,store_id,product_id,unit_name,is_base,factor_num,factor_den,
        measurement_type,operation_id)
       values($1,$2,$3,'base',true,1,1,'count',$4)`,
      [baseUnitId, storeId, productId, randomUUID()],
    );
    return { productId, baseUnitId };
  }

  async function stock(productId: string) {
    return (
      await db().admin.query<{
        quantity: string;
        value: string;
        average: string;
        state: string;
        lastMovementId: string | null;
        version: string;
      }>(
        `select quantity_milli::text as quantity, inventory_value_minor::text as value,
          average_unit_cost_minor::text as average, cost_state as state,
          last_movement_id as "lastMovementId", version::text as version
         from ledger.stock_balances where product_id=$1`,
        [productId],
      )
    ).rows[0];
  }

  async function configuredUnit(product: ProductFixture, factorNum: number) {
    const unitId = randomUUID();
    await db().admin.query(
      `insert into ledger.product_units(
        id,store_id,product_id,unit_name,is_base,factor_num,factor_den,
        measurement_type,operation_id)
       values($1,$2,$3,$4,false,$5,1,'count',$6)`,
      [unitId, owner.storeId, product.productId, `configured-${unitId}`, factorNum, randomUUID()],
    );
    return unitId;
  }

  async function auditChangeCounts() {
    return (
      await db().admin.query<{ audit: number; changes: number }>(
        `select
          (select count(*)::int from audit.central_audit_logs) as audit,
          (select count(*)::int from sync.change_events) as changes`,
      )
    ).rows[0];
  }

  async function operation(operationId: string, storeId = owner.storeId) {
    return (
      await db().admin.query<{
        status: string;
        errorCode: string | null;
        action: string;
        responseBody: unknown;
      }>(
        `select status,error_code as "errorCode",action,response_body as "responseBody"
         from sync.processed_operations where store_id=$1 and operation_id=$2`,
        [storeId, operationId],
      )
    ).rows[0];
  }

  async function movementCount(productId: string) {
    return (
      (
        await db().admin.query<{ count: number }>(
          'select count(*)::int as count from ledger.inventory_movements where product_id=$1',
          [productId],
        )
      ).rows[0]?.count ?? -1
    );
  }

  beforeAll(async () => {
    const environment = readLocalPostgresTestEnvironment();
    if (!environment) throw new Error('Approved non-production local test environment required.');
    database = await createInventoryTestDatabase(stockCountMigrationFilename);
    const migration = await db().migration.connect();
    try {
      await verifyMigrationSession(migration);
      await applyMigration(migration, db().file);
    } finally {
      await migration.query('rollback');
      await migration.query('reset role');
      migration.release();
    }
    const name = (await db().admin.query<{ name: string }>('select current_database() as name'))
      .rows[0]?.name;
    if (!name || !/^dokana_s112_[0-9a-f]{32}$/.test(name) || name === environment.databaseName) {
      throw new Error('Inventory correction test database is not isolated.');
    }
    const url = (source: string) => {
      const value = new URL(source);
      value.pathname = `/${name}`;
      return value.toString();
    };
    runtimePool = createTestPool(url(environment.runtimeUrl), 'dokana-s116-runtime', 8);
    authPool = createTestPool(url(environment.authUrl), 'dokana-s116-auth', 3);

    for (const storeId of new Set(identities.map((identity) => identity.storeId))) {
      await db().admin.query(`insert into ledger.stores(id,name) values($1,'S11.6 fixture')`, [
        storeId,
      ]);
    }
    const password = randomUUID();
    const hash = await new PasswordService().hash(password);
    for (const identity of identities) {
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S11.6 fixture')`,
        [identity.userId, identity.email, hash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
         values($1,$2,$3,$4,'active')`,
        [randomUUID(), identity.storeId, identity.userId, identity.role],
      );
    }

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_POOL)
      .useValue(runtimePool)
      .overrideProvider(AUTH_DATABASE_POOL)
      .useValue(authPool)
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useFactory({
        factory: (config: AppConfigService) =>
          createLoggingParams(config, { write: () => undefined }),
        inject: [AppConfigService],
      })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.useLogger(app.get(Logger));
    configureApplication(app, app.get(AppConfigService));
    await app.init();
    server = app.getHttpServer();

    for (const identity of identities) {
      const response = await request(server)
        .post('/v1/auth/login')
        .send({
          email: identity.email,
          password,
          storeId: identity.storeId,
          deviceId: identity.deviceId,
          deviceName: 'S11.6 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = response.body as { accessToken?: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('Login token is missing.');
      identity.token = body.accessToken;
    }
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      else {
        await runtimePool?.end();
        await authPool?.end();
      }
      if (database) {
        expect(
          (
            await database.admin.query(
              `select count(*)::int as count from pg_stat_activity
               where datname=current_database() and state like 'idle in transaction%'`,
            )
          ).rows[0],
        ).toEqual({ count: 0 });
      }
    } finally {
      await database?.close();
    }
  });

  it('reverses active Opening, Increase and Decrease leaves without changing history', async () => {
    const openingProduct = await product();
    const opening = inventoryInput(openingProduct, { totalPurchaseCostMinor: '10' });
    const openingPosted = await postInventory('opening', opening).expect(201);
    const openingResponse = openingPosted.body as InventoryPostingResponse;
    const openingCorrection = reversal(opening.operationId);
    const openingReversed = await postCorrection(openingCorrection).expect(201);
    expect(openingReversed.body).toMatchObject({
      targetFamily: 'opening',
      correctionType: 'REVERSAL',
      replacement: null,
      reversalMovements: [{ reversedMovementId: openingResponse.movementId }],
    });
    expect(await stock(openingProduct.productId)).toMatchObject({
      quantity: '0',
      value: '0',
      state: 'known',
    });

    const increaseProduct = await product();
    const increase = inventoryInput(increaseProduct, { totalPurchaseCostMinor: '7' });
    await postInventory('increase', increase).expect(201);
    await postCorrection(reversal(increase.operationId)).expect(201);
    expect(await stock(increaseProduct.productId)).toMatchObject({ quantity: '0', value: '0' });

    const decreaseProduct = await product();
    await postInventory(
      'opening',
      inventoryInput(decreaseProduct, {
        selectedQuantityMilli: '5000',
        totalPurchaseCostMinor: '50',
      }),
    ).expect(201);
    const decrease = inventoryInput(decreaseProduct, { reason: 'recorded loss' });
    await postInventory('decrease', decrease).expect(201);
    await postCorrection(reversal(decrease.operationId)).expect(201);
    expect(await stock(decreaseProduct.productId)).toMatchObject({
      quantity: '5000',
      value: '50',
      state: 'known',
    });

    expect(
      (
        await db().admin.query(
          `select count(*)::int as count from ledger.inventory_movements
           where id=$1 and quantity_delta_milli=1000 and reversal_of_id is null`,
          [openingResponse.movementId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    await postCorrection(reversal(opening.operationId)).expect(409);
  });

  it('replaces same-family Opening, Increase and Decrease and advances one linear leaf', async () => {
    const openingProduct = await product();
    const opening = inventoryInput(openingProduct, { totalPurchaseCostMinor: '10' });
    await postInventory('opening', opening).expect(201);
    const openingReplacement = replacement(opening.operationId, 'opening', {
      productId: openingProduct.productId,
      productUnitId: openingProduct.baseUnitId,
      selectedQuantityMilli: '2000',
      totalPurchaseCostMinor: '20',
    });
    const replacedOpening = await postCorrection(openingReplacement).expect(201);
    expect(replacedOpening.body).toMatchObject({
      targetFamily: 'opening',
      replacement: { family: 'opening', operation: { kind: 'opening' } },
    });
    expect(await stock(openingProduct.productId)).toMatchObject({ quantity: '2000', value: '20' });
    await postCorrection(reversal(opening.operationId)).expect(409);
    await postCorrection(reversal(openingReplacement.operationId)).expect(201);
    expect(await stock(openingProduct.productId)).toMatchObject({ quantity: '0', value: '0' });

    const increaseProduct = await product();
    const increase = inventoryInput(increaseProduct, { totalPurchaseCostMinor: '5' });
    await postInventory('increase', increase).expect(201);
    const increaseReplacement = replacement(increase.operationId, 'increase', {
      productId: increaseProduct.productId,
      productUnitId: increaseProduct.baseUnitId,
      selectedQuantityMilli: '3000',
      totalPurchaseCostMinor: '15',
    });
    await postCorrection(increaseReplacement).expect(201);
    expect(await stock(increaseProduct.productId)).toMatchObject({ quantity: '3000', value: '15' });

    const decreaseProduct = await product();
    await postInventory(
      'opening',
      inventoryInput(decreaseProduct, {
        selectedQuantityMilli: '5000',
        totalPurchaseCostMinor: '50',
      }),
    ).expect(201);
    const decrease = inventoryInput(decreaseProduct, { reason: 'first loss' });
    await postInventory('decrease', decrease).expect(201);
    await postCorrection(
      replacement(decrease.operationId, 'decrease', {
        productId: decreaseProduct.productId,
        productUnitId: decreaseProduct.baseUnitId,
        selectedQuantityMilli: '2000',
        reason: 'correct loss',
      }),
    ).expect(201);
    expect(await stock(decreaseProduct.productId)).toMatchObject({
      quantity: '3000',
      value: '30',
      state: 'known',
    });
  });

  it('uses persisted unit snapshots and preserves known-zero, unknown and pending cost states', async () => {
    const historical = await product();
    const historicalUnitId = await configuredUnit(historical, 10);
    const historicalInput = inventoryInput(historical, {
      productUnitId: historicalUnitId,
      totalPurchaseCostMinor: '20',
    });
    await postInventory('increase', historicalInput).expect(201);
    expect(await stock(historical.productId)).toMatchObject({ quantity: '10000', value: '20' });
    await db().admin.query(
      `update ledger.product_units set factor_num=12,status='archived' where id=$1`,
      [historicalUnitId],
    );
    await postCorrection(reversal(historicalInput.operationId)).expect(201);
    expect(await stock(historical.productId)).toMatchObject({
      quantity: '0',
      value: '0',
      state: 'known',
    });

    const unknown = await product();
    const unknownInput = inventoryInput(unknown);
    await postInventory('increase', unknownInput).expect(201);
    const unknownReversal = await postCorrection(reversal(unknownInput.operationId)).expect(201);
    expect(unknownReversal.body).toMatchObject({
      reversalMovements: [{ costStateBefore: 'unknown', costStateAfter: 'known' }],
    });
    expect(await stock(unknown.productId)).toMatchObject({ state: 'known', value: '0' });

    const knownZero = await product();
    const zeroInput = inventoryInput(knownZero, { totalPurchaseCostMinor: '0' });
    await postInventory('increase', zeroInput).expect(201);
    await postCorrection(reversal(zeroInput.operationId)).expect(201);
    expect(await stock(knownZero.productId)).toMatchObject({ state: 'known', value: '0' });

    const pending = await product({ allowNegative: true });
    const pendingInput = inventoryInput(pending, { reason: 'negative correction fixture' });
    await postInventory('decrease', pendingInput).expect(201);
    const pendingReversal = await postCorrection(reversal(pendingInput.operationId)).expect(201);
    expect(pendingReversal.body).toMatchObject({
      reversalMovements: [{ costStateBefore: 'pending', costStateAfter: 'known' }],
    });
    expect(await stock(pending.productId)).toMatchObject({
      quantity: '0',
      state: 'known',
      value: '0',
    });
  });

  it('enforces same-family replacement and preserves Opening uniqueness on another Product', async () => {
    const source = await product();
    const occupied = await product();
    const sourceOpening = inventoryInput(source, { totalPurchaseCostMinor: '1' });
    await postInventory('opening', sourceOpening).expect(201);
    await postInventory(
      'increase',
      inventoryInput(occupied, { totalPurchaseCostMinor: '1' }),
    ).expect(201);
    await postCorrection(
      replacement(sourceOpening.operationId, 'increase', {
        productId: source.productId,
        productUnitId: source.baseUnitId,
        selectedQuantityMilli: '1000',
      }),
    ).expect(409);
    await postCorrection(
      replacement(sourceOpening.operationId, 'opening', {
        productId: occupied.productId,
        productUnitId: occupied.baseUnitId,
        selectedQuantityMilli: '1000',
      }),
    ).expect(409);
    expect(await stock(source.productId)).toMatchObject({ quantity: '1000' });
    expect(await stock(occupied.productId)).toMatchObject({ quantity: '1000' });
  });

  it('reverses and replaces a whole established multi-Product Stock Count', async () => {
    const first = await product();
    const second = await product();
    for (const fixture of [first, second]) {
      await postInventory(
        'opening',
        inventoryInput(fixture, {
          selectedQuantityMilli: '3000',
          totalPurchaseCostMinor: '12',
        }),
      ).expect(201);
    }
    const count = countInput([
      {
        productId: second.productId,
        productUnitId: second.baseUnitId,
        actualQuantityMilli: '2000',
      },
      { productId: first.productId, productUnitId: first.baseUnitId, actualQuantityMilli: '2000' },
    ]);
    await postCount(count).expect(201);
    const correction = replacement(count.operationId, 'stock_count', {
      countType: 'partial',
      items: [
        {
          productId: second.productId,
          productUnitId: second.baseUnitId,
          actualQuantityMilli: '1000',
        },
        {
          productId: first.productId,
          productUnitId: first.baseUnitId,
          actualQuantityMilli: '1000',
        },
      ],
    });
    const response = await postCorrection(correction).expect(201);
    expect(response.body).toMatchObject({
      targetFamily: 'stock_count',
      reversalMovements: [
        { productId: expect.any(String) as string },
        { productId: expect.any(String) as string },
      ],
      replacement: { family: 'stock_count', operation: { countType: 'partial' } },
    });
    expect(
      (response.body as InventoryCorrectionResponse).reversalMovements.map(
        (movement) => movement.productId,
      ),
    ).toEqual([first.productId, second.productId].sort());
    expect(await stock(first.productId)).toMatchObject({ quantity: '1000', value: '4' });
    expect(await stock(second.productId)).toMatchObject({ quantity: '1000', value: '4' });
    await postCorrection(reversal(count.operationId)).expect(409);
    await postCorrection(reversal(correction.operationId)).expect(201);
    expect(await stock(first.productId)).toMatchObject({ quantity: '3000', value: '12' });
    expect(await stock(second.productId)).toMatchObject({ quantity: '3000', value: '12' });
    await request(server)
      .post(`/v1/inventory/counts/${randomUUID()}/correction`)
      .set('authorization', `Bearer ${owner.token}`)
      .send(reversal(correction.operationId))
      .expect(404);
  });

  it.each(['0', '1000'])(
    'rejects reversal and replacement of MISSING establishment %s without inventory effects',
    async (actualQuantityMilli) => {
      const fixture = await product();
      const count = countInput([
        {
          productId: fixture.productId,
          productUnitId: fixture.baseUnitId,
          actualQuantityMilli,
        },
      ]);
      await postCount(count).expect(201);
      const before = await stock(fixture.productId);
      const beforeMovements = await movementCount(fixture.productId);
      const beforeEvidence = await auditChangeCounts();
      const reverse = reversal(count.operationId);
      const replace = replacement(count.operationId, 'stock_count', {
        countType: 'partial',
        items: [
          {
            productId: fixture.productId,
            productUnitId: fixture.baseUnitId,
            actualQuantityMilli: '2000',
          },
        ],
      });
      for (const body of [reverse, replace]) {
        const rejected = await postCorrection(body).expect(409);
        expect(rejected.body).toMatchObject({
          code: 'INVENTORY_CORRECTION_MISSING_PROJECTION_UNSUPPORTED',
        });
        expect(await operation(body.operationId)).toMatchObject({
          status: 'rejected',
          errorCode: 'INVENTORY_CORRECTION_MISSING_PROJECTION_UNSUPPORTED',
        });
      }
      expect(await stock(fixture.productId)).toEqual(before);
      expect(await movementCount(fixture.productId)).toBe(beforeMovements);
      expect(await auditChangeCounts()).toEqual(beforeEvidence);
      expect((await postCorrection(reverse).expect(409)).body).toMatchObject({
        code: 'INVENTORY_CORRECTION_MISSING_PROJECTION_UNSUPPORTED',
      });

      const currentCount = countInput([
        {
          productId: fixture.productId,
          productUnitId: fixture.baseUnitId,
          actualQuantityMilli: '5000',
        },
      ]);
      await postCount(currentCount).expect(201);
      expect(await stock(fixture.productId)).toMatchObject({ quantity: '5000' });
    },
  );

  it('replays exactly, conflicts on changed requests, and survives later closure/lifecycle changes', async () => {
    const fixture = await product();
    const postedInput = inventoryInput(fixture, {
      totalPurchaseCostMinor: '8',
      occurredAt: '2026-04-15T10:00:00Z',
    });
    await postInventory('increase', postedInput).expect(201);
    const correction = reversal(postedInput.operationId, {
      occurredAt: '2026-04-16T10:00:00Z',
    });
    const accepted = await postCorrection(correction).expect(201);
    expect((await postCorrection(correction).expect(201)).body).toEqual(accepted.body);
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=now()
       where id=$1`,
      [(accepted.body as InventoryCorrectionResponse).accountingPeriodId],
    );
    await db().admin.query(
      `update ledger.products set status='archived',archived_at=now(),track_inventory=false
       where id=$1`,
      [fixture.productId],
    );
    await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
      owner.storeId,
    ]);
    try {
      expect((await postCorrection(correction).expect(201)).body).toEqual(accepted.body);
      await postCorrection({ ...correction, occurredAt: '2026-04-17T10:00:00Z' }).expect(409);
    } finally {
      await db().admin.query(`update ledger.stores set status='active' where id=$1`, [
        owner.storeId,
      ]);
    }
    expect(
      (
        await db().admin.query(
          'select count(*)::int as count from sync.conflicts where operation_id=$1',
          [correction.operationId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  });

  it('serializes competing corrections and leaves one terminating successor', async () => {
    const fixture = await product();
    const input = inventoryInput(fixture, { totalPurchaseCostMinor: '5' });
    await postInventory('increase', input).expect(201);
    const first = reversal(input.operationId);
    const second = reversal(input.operationId);
    const results = await Promise.all([postCorrection(first), postCorrection(second)]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(results.find((response) => response.status === 409)?.body).toMatchObject({
      code: 'INVENTORY_CORRECTION_TARGET_NOT_ACTIVE',
    });
    expect(await stock(fixture.productId)).toMatchObject({ quantity: '0', value: '0' });
    expect(await movementCount(fixture.productId)).toBe(2);
  });

  it('fails closed across Stores and allows only the authenticated Store owner', async () => {
    const foreignProduct = await product({ storeId: foreignOwner.storeId });
    const foreignInput = inventoryInput(foreignProduct);
    await postInventory('increase', foreignInput, foreignOwner).expect(201);
    const hidden = await postCorrection(reversal(foreignInput.operationId)).expect(404);
    const absent = await postCorrection(reversal(randomUUID())).expect(404);
    const absentBody = absent.body as { code: string };
    expect(hidden.body).toMatchObject({ code: absentBody.code });

    const localProduct = await product();
    const localInput = inventoryInput(localProduct);
    await postInventory('increase', localInput).expect(201);
    const correction = reversal(localInput.operationId);
    await request(server).post('/v1/inventory/corrections').send(correction).expect(401);
    await postCorrection(correction, manager).expect(403);
    await postCorrection(correction).set('x-store-id', foreignOwner.storeId).expect(201);
  });

  it('rejects closed-period and recost-required corrections with no partial reversal', async () => {
    const fixture = await product();
    const target = inventoryInput(fixture, { totalPurchaseCostMinor: '4' });
    await postInventory('increase', target).expect(201);
    const later = inventoryInput(fixture, { totalPurchaseCostMinor: '4' });
    await postInventory('increase', later).expect(201);
    const oldCorrection = reversal(target.operationId);
    await postCorrection(oldCorrection).expect(409);
    expect(await operation(oldCorrection.operationId)).toMatchObject({
      errorCode: 'INVENTORY_CORRECTION_REQUIRES_RECOST',
    });
    expect(await stock(fixture.productId)).toMatchObject({ quantity: '2000', value: '8' });

    const unknownProduct = await product();
    await postInventory(
      'opening',
      inventoryInput(unknownProduct, {
        selectedQuantityMilli: '3000',
        totalPurchaseCostMinor: '12',
      }),
    ).expect(201);
    const count = countInput([
      {
        productId: unknownProduct.productId,
        productUnitId: unknownProduct.baseUnitId,
        actualQuantityMilli: '4000',
      },
    ]);
    await postCount(count).expect(201);
    await postCorrection(reversal(count.operationId)).expect(409);
    expect(await stock(unknownProduct.productId)).toMatchObject({
      quantity: '4000',
      value: '0',
      state: 'unknown',
    });

    const closedProduct = await product();
    const closedTarget = inventoryInput(closedProduct, { totalPurchaseCostMinor: '2' });
    await postInventory('increase', closedTarget).expect(201);
    const periodSeed = await product();
    const seed = await postInventory(
      'increase',
      inventoryInput(periodSeed, {
        occurredAt: '2026-03-10T10:00:00Z',
        totalPurchaseCostMinor: '1',
      }),
    ).expect(201);
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=now() where id=$1`,
      [(seed.body as InventoryPostingResponse).accountingPeriodId],
    );
    const closedCorrection = reversal(closedTarget.operationId, {
      occurredAt: '2026-03-15T10:00:00Z',
    });
    await postCorrection(closedCorrection).expect(409);
    expect(await operation(closedCorrection.operationId)).toMatchObject({
      errorCode: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
    });
    expect(await stock(closedProduct.productId)).toMatchObject({ quantity: '1000' });
  });

  it('rolls back the correction claim, movements, projection, audit and change effects atomically', async () => {
    if (!app) throw new Error('Inventory correction application is unavailable.');
    const fixture = await product();
    const target = inventoryInput(fixture, { totalPurchaseCostMinor: '3' });
    await postInventory('increase', target).expect(201);
    const body = reversal(target.operationId);
    const beforeMovements = await movementCount(fixture.productId);
    const beforeEvidence = await auditChangeCounts();
    const service = app.get(DatabaseService);
    const original = service.withTenantTransaction.bind(service);
    const spy = jest.spyOn(service, 'withTenantTransaction').mockImplementation((context, work) =>
      original(context, async (transaction) => {
        await work(transaction);
        throw new Error('S11.6 controlled rollback');
      }),
    );
    try {
      await postCorrection(body).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await operation(body.operationId)).toBeUndefined();
    expect(await stock(fixture.productId)).toMatchObject({ quantity: '1000', value: '3' });
    expect(await movementCount(fixture.productId)).toBe(beforeMovements);
    expect(await auditChangeCounts()).toEqual(beforeEvidence);
    await postCorrection(body).expect(201);
  });

  it('creates audit/change evidence but no Supplier, Sales, Money or other accounting effects', async () => {
    const excludedTables = [
      'purchase_invoices',
      'goods_receipts',
      'supplier_ledger_entries',
      'supplier_payments',
      'sales',
      'sale_items',
      'money_movements',
      'expenses',
    ];
    const before = new Map<string, number>();
    for (const table of excludedTables) {
      before.set(
        table,
        (
          await db().admin.query<{ count: number }>(
            `select count(*)::int as count from ledger.${table}`,
          )
        ).rows[0]?.count ?? -1,
      );
    }
    const fixture = await product();
    const target = inventoryInput(fixture, { totalPurchaseCostMinor: '2' });
    await postInventory('increase', target).expect(201);
    const response = await postCorrection(reversal(target.operationId)).expect(201);
    const correction = response.body as InventoryCorrectionResponse;
    const reversalId = correction.reversalMovements[0]?.movementId;
    expect(reversalId).toBeDefined();
    expect(
      (
        await db().admin.query(
          `select
            (select count(*)::int from audit.central_audit_logs where entity_id=$1) as audit,
            (select count(*)::int from sync.change_events where entity_id=$1) as changes`,
          [reversalId],
        )
      ).rows[0],
    ).toEqual({ audit: 1, changes: 1 });
    for (const table of excludedTables) {
      expect(
        (
          await db().admin.query<{ count: number }>(
            `select count(*)::int as count from ledger.${table}`,
          )
        ).rows[0]?.count,
      ).toBe(before.get(table));
    }
  });

  it('fails closed when repository tenant context is missing', async () => {
    if (!app) throw new Error('Inventory correction application is unavailable.');
    await expect(
      app.get(InventoryCorrectionRepository).correct(
        {
          storeId: '',
          userId: owner.userId,
          deviceId: owner.deviceId,
          requestId: randomUUID(),
        },
        parseInventoryCorrectionCommand(reversal(randomUUID())),
        '2026-01-15',
      ),
    ).rejects.toThrow(TypeError);
  });
});
