import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { captureReplayEvidence } from './stage3b-replay-evidence';
import { interceptOperationQueries } from './stage3b-driver-boundary';
import {
  assertInventoryReconciles,
  inventoryFinancialEvidence,
} from './stage4b-inventory-evidence';
import { DatabaseService } from '../src/database/database.service';
import type { Server } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import type { SaleReturnPostingResponse } from '../src/returns/sale-return-posting.types';
import type { SaleReturnCorrectionResponse } from '../src/returns/sale-return-correction.types';
import type { SalePostingResponse } from '../src/sales/sale-posting.types';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
  upgradeInventoryTestDatabaseToCurrent,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0015_sale_customer_credit_tender.sql';

interface Identity {
  storeId: string;
  userId: string;
  deviceId: string;
  email: string;
  role: 'owner' | 'manager';
  storeStatus: 'active' | 'read_only';
  token: string;
}

interface ProductFixture {
  productId: string;
  unitId: string;
}

const primaryStoreId = randomUUID();
const identities: [Identity, Identity, Identity, Identity] = [
  {
    storeId: primaryStoreId,
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s173-owner-${randomUUID()}@example.test`,
    role: 'owner',
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: primaryStoreId,
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s173-manager-${randomUUID()}@example.test`,
    role: 'manager',
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s173-foreign-${randomUUID()}@example.test`,
    role: 'owner',
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s173-read-only-${randomUUID()}@example.test`,
    role: 'owner',
    storeStatus: 'read_only',
    token: '',
  },
];
const [owner, manager, foreignOwner, readOnlyOwner] = identities;

describe('S17.3 atomic Customer Sale Return posting on isolated PostgreSQL', () => {
  jest.setTimeout(300_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  let acceptedAt: Date;
  let occurredAt: string;
  let periodId: string;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S17.3 database is unavailable.');
    return database;
  }

  function authorized(identity: Identity = owner): { authorization: string } {
    return { authorization: `Bearer ${identity.token}` };
  }

  function postReturn(
    saleId: string,
    body: Record<string, unknown>,
    identity: Identity = owner,
  ): request.Test {
    return request(server).post(`/v1/sales/${saleId}/return`).set(authorized(identity)).send(body);
  }

  function returnRequest(
    sale: SalePostingResponse,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const item = sale.items[0];
    if (!item) throw new Error('Sale Return fixture requires a Sale line.');
    return {
      operationId: randomUUID(),
      occurredAt,
      reason: 'Customer returned the Sale line',
      lines: [
        {
          saleItemId: item.id,
          quantityMilli: item.quantityMilli,
          disposition: 'DAMAGED_NO_RESTOCK',
        },
      ],
      ...overrides,
    };
  }

  async function createCustomer(
    identity: Identity = owner,
    status: 'active' | 'archived' = 'active',
  ): Promise<string> {
    const id = randomUUID();
    await db().admin.query(
      `insert into ledger.customers(
        id,store_id,name,normalized_name,phone,normalized_phone,status,archived_at,
        device_id,operation_id
      ) values($1,$2,$1::uuid::text,$1::uuid::text,$1::uuid::text,$1::uuid::text,$3,
        case when $3='archived' then clock_timestamp() else null end,$4,$5)`,
      [id, identity.storeId, status, identity.deviceId, randomUUID()],
    );
    return id;
  }

  async function createAccount(
    identity: Identity = owner,
    status: 'active' | 'archived' = 'active',
  ): Promise<string> {
    const id = randomUUID();
    await db().admin.query(
      `insert into ledger.money_accounts(
        id,store_id,name,normalized_name,account_type,availability,status,archived_at,operation_id
      ) values($1,$2,$1::uuid::text,$1::uuid::text,'transfer','available',$3,
        case when $3='archived' then clock_timestamp() else null end,$4)`,
      [id, identity.storeId, status, randomUUID()],
    );
    return id;
  }

  async function createProduct(): Promise<ProductFixture> {
    const productId = randomUUID();
    const unitId = randomUUID();
    await db().admin.query(
      `insert into ledger.products(
        id,store_id,name,normalized_name,measurement_type,track_inventory,status,operation_id
      ) values($1,$2,$1::uuid::text,$1::uuid::text,'count',true,'active',$3)`,
      [productId, owner.storeId, randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.product_units(
        id,store_id,product_id,measurement_type,unit_name,is_base,
        factor_num,factor_den,status,operation_id
      ) values($1,$2,$3,'count','piece',true,1,1,'active',$4)`,
      [unitId, owner.storeId, productId, randomUUID()],
    );
    return { productId, unitId };
  }

  async function seedInventory(
    product: ProductFixture,
    costMinor?: string,
    quantityMilli = '2000',
  ): Promise<void> {
    const body: Record<string, unknown> = {
      operationId: randomUUID(),
      productId: product.productId,
      productUnitId: product.unitId,
      selectedQuantityMilli: quantityMilli,
      occurredAt,
    };
    if (costMinor !== undefined) body.totalPurchaseCostMinor = costMinor;
    await request(server).post('/v1/inventory/increase').set(authorized()).send(body).expect(201);
  }

  async function postManualSale(input: {
    identity?: Identity;
    customerId?: string;
    accountId?: string;
    saleAt?: string;
    customerCreditAmountMinor?: string;
    paymentAmountMinor?: string;
  }): Promise<SalePostingResponse> {
    const response = await request(server)
      .post('/v1/sales')
      .set(authorized(input.identity ?? owner))
      .send({
        operationId: randomUUID(),
        ...(input.customerId ? { customerId: input.customerId } : {}),
        occurredAt: input.saleAt ?? occurredAt,
        items: [
          {
            isManualLine: true,
            description: 'S17.3 manual Sale line',
            unitName: 'service',
            quantityMilli: '1000',
            unitPriceMinor: '500',
            lineTotalMinor: '500',
          },
        ],
        payments: input.accountId
          ? [{ moneyAccountId: input.accountId, amountMinor: input.paymentAmountMinor ?? '500' }]
          : [],
        ...(input.customerCreditAmountMinor
          ? { customerCreditAmountMinor: input.customerCreditAmountMinor }
          : {}),
        totalMinor: '500',
      })
      .expect(201);
    return response.body as SalePostingResponse;
  }

  async function postTrackedSale(
    product: ProductFixture,
    accountId: string,
  ): Promise<SalePostingResponse> {
    const response = await request(server)
      .post('/v1/sales')
      .set(authorized())
      .send({
        operationId: randomUUID(),
        occurredAt,
        items: [
          {
            isManualLine: false,
            productId: product.productId,
            productUnitId: product.unitId,
            quantityMilli: '1000',
            unitPriceMinor: '500',
            lineTotalMinor: '500',
          },
        ],
        payments: [{ moneyAccountId: accountId, amountMinor: '500' }],
        totalMinor: '500',
      })
      .expect(201);
    return response.body as SalePostingResponse;
  }

  async function customerBalances(
    customerId: string,
  ): Promise<{ receivable: string; credit: string }> {
    const row = (
      await db().admin.query<{ receivable: string; credit: string }>(
        `select receivable_minor::text as receivable,credit_minor::text as credit
         from ledger.v_customer_balances where store_id=$1 and customer_id=$2`,
        [owner.storeId, customerId],
      )
    ).rows[0];
    return row ?? { receivable: '0', credit: '0' };
  }

  async function stock(
    productId: string,
  ): Promise<{ quantity: string; value: string; state: string }> {
    const row = (
      await db().admin.query<{ quantity: string; value: string; state: string }>(
        `select quantity_milli::text as quantity,inventory_value_minor::text as value,
                cost_state as state
         from ledger.stock_balances where store_id=$1 and product_id=$2`,
        [owner.storeId, productId],
      )
    ).rows[0];
    if (!row) throw new Error('Stock projection is missing.');
    return row;
  }

  it('S4B2-01 reconciles each inventory family, count establishment and rollback against authoritative history', async () => {
    const product = await createProduct();
    const inventory = (kind: string, quantity: string, cost?: string) =>
      request(server)
        .post(`/v1/inventory/${kind}`)
        .set(authorized())
        .send({
          operationId: randomUUID(),
          productId: product.productId,
          productUnitId: product.unitId,
          selectedQuantityMilli: quantity,
          occurredAt,
          reason: 'Stage 4B sequence',
          ...(cost === undefined ? {} : { totalPurchaseCostMinor: cost }),
        });
    const reconcile = () => assertInventoryReconciles(db().admin, owner.storeId, product.productId);
    const financialBefore = await inventoryFinancialEvidence(db().admin, owner.storeId);
    await inventory('opening', '10000', '1000').expect(201);
    await reconcile();
    await inventory('increase', '2000', '240').expect(201);
    await reconcile();
    await inventory('decrease', '1000').expect(201);
    await reconcile();
    expect(await inventoryFinancialEvidence(db().admin, owner.storeId)).toEqual(financialBefore);
    const account = await createAccount();
    const sale = await postTrackedSale(product, account);
    await reconcile();
    await postReturn(
      sale.sale.id,
      returnRequest(sale, {
        lines: [
          { saleItemId: sale.items[0]?.id, quantityMilli: '1000', disposition: 'RESTOCK_SALEABLE' },
        ],
        residualSettlement: { choice: 'REFUND', moneyAccountId: account },
      }),
    ).expect(201);
    await reconcile();
    const financialAfterSale = await inventoryFinancialEvidence(db().admin, owner.storeId);
    const count = (p: ProductFixture, actual: string, operationId = randomUUID()) =>
      request(server)
        .post('/v1/inventory/counts')
        .set(authorized())
        .send({
          operationId,
          countType: 'partial',
          occurredAt,
          items: [{ productId: p.productId, productUnitId: p.unitId, actualQuantityMilli: actual }],
        });
    await count(product, '13000').expect(201);
    await reconcile();
    const target = randomUUID();
    await count(product, '12000', target).expect(201);
    await reconcile();
    const unchangedBefore = await stock(product.productId);
    const unchanged = await count(product, '12000').expect(201);
    expect(unchanged.body).toMatchObject({ items: [{ movementId: null, adjustmentKind: 'none' }] });
    expect(await stock(product.productId)).toEqual(unchangedBefore);
    await reconcile();
    await request(server)
      .post('/v1/inventory/corrections')
      .set(authorized())
      .send({
        operationId: randomUUID(),
        targetOperationId: target,
        correctionType: 'REVERSAL',
        occurredAt,
      })
      .expect(201);
    await reconcile();
    for (const actual of ['0', '5000']) {
      const missing = await createProduct();
      const result = await count(missing, actual).expect(201);
      expect(result.body).toMatchObject({
        items: [
          {
            previousProjectionState: 'MISSING',
            adjustmentKind: 'establishment',
            quantityFactKind: actual === '0' ? 'count_zero_establishment' : 'movement',
          },
        ],
      });
      await assertInventoryReconciles(db().admin, owner.storeId, missing.productId);
    }
    expect(await inventoryFinancialEvidence(db().admin, owner.storeId)).toEqual(financialAfterSale);
    if (!app) throw new Error('Application unavailable');
    const tables = [
      'ledger.inventory_movements',
      'ledger.stock_balances',
      'ledger.manual_inventory_entries',
      'ledger.stock_counts',
      'ledger.stock_count_items',
    ];
    const beforeFailure = await captureReplayEvidence(db().admin, owner.storeId, tables);
    const service = app.get(DatabaseService);
    const original = service.withTenantTransaction.bind(service);
    const spy = jest.spyOn(service, 'withTenantTransaction').mockImplementation((context, work) =>
      original(context, async (transaction) => {
        await work(transaction);
        throw new Error('Stage 4B after staged inventory');
      }),
    );
    try {
      await inventory('increase', '1000', '10').expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await captureReplayEvidence(db().admin, owner.storeId, tables)).toEqual(beforeFailure);
    await reconcile();
  });

  it('S4B2-02 preserves unresolved cost, exact empty-stock boundaries and immutable historical costs', async () => {
    const account = await createAccount();
    for (const initial of ['known', 'zero', 'unknown', 'pending'] as const) {
      const product = await createProduct();
      if (initial === 'pending') {
        await db().admin.query(
          'update ledger.products set allow_negative_stock_override=true where id=$1',
          [product.productId],
        );
      } else {
        await seedInventory(
          product,
          initial === 'known' ? '10' : initial === 'zero' ? '0' : undefined,
          '5000',
        );
        expect(await stock(product.productId)).toEqual({
          quantity: '5000',
          value: initial === 'known' ? '10' : '0',
          state: initial === 'unknown' ? 'unknown' : 'known',
        });
      }
      const sale = await postTrackedSale(product, account);
      expect(sale.items[0]).toMatchObject({
        costStatus: initial === 'zero' ? 'known' : initial,
        lineCostMinor: initial === 'known' ? '2' : initial === 'zero' ? '0' : null,
      });
      const before = await captureReplayEvidence(db().admin, owner.storeId, [
        'ledger.inventory_movements',
        'ledger.sale_items',
      ]);
      if (initial === 'pending') {
        expect(await stock(product.productId)).toEqual({
          quantity: '-1000',
          value: '0',
          state: 'pending',
        });
        await seedInventory(product, '8', '2000');
        expect(await stock(product.productId)).toEqual({
          quantity: '1000',
          value: '0',
          state: 'pending',
        });
      } else {
        await seedInventory(product, undefined, '1000');
        expect((await stock(product.productId)).state).toBe('unknown');
        await seedInventory(product, '9', '1000');
        expect(await stock(product.productId)).toEqual({
          quantity: '6000',
          value: '0',
          state: 'unknown',
        });
      }
      const unresolved = await request(server)
        .get(`/v1/inventory/stock/${product.productId}`)
        .set(authorized())
        .expect(200);
      expect(unresolved.body).toMatchObject({
        stock: {
          cost: {
            status: initial === 'pending' ? 'pending' : 'unknown',
            valueMinor: null,
            averageUnitCostMinor: null,
          },
        },
      });
      await assertInventoryReconciles(db().admin, owner.storeId, product.productId);
      const current = await stock(product.productId);
      await request(server)
        .post('/v1/inventory/decrease')
        .set(authorized())
        .send({
          operationId: randomUUID(),
          productId: product.productId,
          productUnitId: product.unitId,
          occurredAt,
          selectedQuantityMilli: current.quantity,
          reason: 'Complete depletion',
        })
        .expect(201);
      expect(await stock(product.productId)).toEqual({ quantity: '0', value: '0', state: 'known' });
      await seedInventory(product, '7', '1000');
      expect(await stock(product.productId)).toEqual({
        quantity: '1000',
        value: '7',
        state: 'known',
      });
      await assertInventoryReconciles(db().admin, owner.storeId, product.productId);
      const after = await captureReplayEvidence(db().admin, owner.storeId, [
        'ledger.inventory_movements',
        'ledger.sale_items',
      ]);
      for (const table of Object.keys(before))
        expect(after[table]).toEqual(expect.arrayContaining(before[table] ?? []));
    }
    const missing = await createProduct();
    const counted = await request(server)
      .post('/v1/inventory/counts')
      .set(authorized())
      .send({
        operationId: randomUUID(),
        occurredAt,
        countType: 'partial',
        items: [
          { productId: missing.productId, productUnitId: missing.unitId, actualQuantityMilli: '0' },
        ],
      })
      .expect(201);
    expect(counted.body).toMatchObject({
      items: [{ stock: { cost: { status: 'unknown', valueMinor: null } } }],
    });
    expect(await stock(missing.productId)).toEqual({ quantity: '0', value: '0', state: 'unknown' });
    await assertInventoryReconciles(db().admin, owner.storeId, missing.productId);
  });

  it('S4B2-06 enforces exact append-only reversal lineage and rejects recost or missing-projection rewind', async () => {
    const inventory = async (product: ProductFixture, cost?: string) => {
      const operationId = randomUUID();
      const result = await request(server)
        .post('/v1/inventory/increase')
        .set(authorized())
        .send({
          operationId,
          productId: product.productId,
          productUnitId: product.unitId,
          selectedQuantityMilli: '1000',
          occurredAt,
          ...(cost === undefined ? {} : { totalPurchaseCostMinor: cost }),
        })
        .expect(201);
      return { operationId, movementId: (result.body as { movementId: string }).movementId };
    };
    const correct = (targetOperationId: string, replacement?: Record<string, unknown>) =>
      request(server)
        .post('/v1/inventory/corrections')
        .set(authorized())
        .send({
          operationId: randomUUID(),
          targetOperationId,
          occurredAt,
          correctionType: replacement ? 'REPLACEMENT' : 'REVERSAL',
          ...(replacement ? { replacement } : {}),
        });
    const tables = [
      'ledger.inventory_movements',
      'ledger.stock_balances',
      'ledger.manual_inventory_entries',
      'ledger.stock_counts',
      'ledger.stock_count_items',
    ];
    const product = await createProduct();
    const original = await inventory(product, '10');
    const originalRow = (
      await db().admin.query<{ row: string }>(
        'select to_jsonb(m)::text as row from ledger.inventory_movements m where id=$1',
        [original.movementId],
      )
    ).rows;
    for (const invalid of [
      { reversal_of_id: randomUUID() },
      { quantity_delta_milli: '1000', quantity_after_milli: '2000' },
      { value_delta_minor: '-9', inventory_value_after_minor: '1' },
    ]) {
      const before = await captureReplayEvidence(db().admin, owner.storeId, tables);
      const client = await db().runtime.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.store_id',$1,true),set_config('app.user_id',$2,true),set_config('app.device_id',$3,true),set_config('app.request_id',$4,true)`,
          [owner.storeId, owner.userId, owner.deviceId, randomUUID()],
        );
        await expect(
          client.query(
            `insert into ledger.inventory_movements select
          (jsonb_populate_record(null::ledger.inventory_movements,to_jsonb(m)||$2::jsonb)).*
          from ledger.inventory_movements m where id=$1`,
            [
              original.movementId,
              JSON.stringify({
                id: randomUUID(),
                operation_id: randomUUID(),
                movement_type: 'correction',
                reversal_of_id: original.movementId,
                quantity_before_milli: '1000',
                quantity_delta_milli: '-1000',
                quantity_after_milli: '0',
                inventory_value_before_minor: '10',
                value_delta_minor: '-10',
                inventory_value_after_minor: '0',
                average_unit_cost_after_minor: '0',
                ...invalid,
              }),
            ],
          ),
        ).rejects.toMatchObject({
          code: '23514',
          message: 'Inventory reversal lineage is inconsistent',
        });
      } finally {
        await client.query('rollback');
        client.release();
      }
      expect(await captureReplayEvidence(db().admin, owner.storeId, tables)).toEqual(before);
    }
    await correct(original.operationId).expect(201);
    expect(
      (
        await db().admin.query<{ row: string }>(
          'select to_jsonb(m)::text as row from ledger.inventory_movements m where id=$1',
          [original.movementId],
        )
      ).rows,
    ).toEqual(originalRow);
    expect(
      (
        await db().admin.query(
          `select count(*)::int as children,
      min(r.quantity_delta_milli+o.quantity_delta_milli)::text as quantity,
      min(r.value_delta_minor+o.value_delta_minor)::text as value
      from ledger.inventory_movements r join ledger.inventory_movements o on o.store_id=r.store_id and o.id=r.reversal_of_id
      where o.id=$1`,
          [original.movementId],
        )
      ).rows[0],
    ).toEqual({ children: 1, quantity: '0', value: '0' });
    const beforeDuplicate = await captureReplayEvidence(db().admin, owner.storeId, tables);
    await correct(original.operationId).expect(409);
    const afterDuplicate = await captureReplayEvidence(db().admin, owner.storeId, tables);
    for (const table of tables) expect(afterDuplicate[table]).toEqual(beforeDuplicate[table]);
    await assertInventoryReconciles(db().admin, owner.storeId, product.productId);
    const replaceTarget = await inventory(product, '10');
    const replaced = await correct(replaceTarget.operationId, {
      family: 'increase',
      productId: product.productId,
      productUnitId: product.unitId,
      selectedQuantityMilli: '2000',
      totalPurchaseCostMinor: '30',
    }).expect(201);
    expect(replaced.body).toMatchObject({
      reversalMovements: [{ reversedMovementId: replaceTarget.movementId }],
      replacement: { family: 'increase' },
    });
    expect(await stock(product.productId)).toEqual({
      quantity: '2000',
      value: '30',
      state: 'known',
    });
    await assertInventoryReconciles(db().admin, owner.storeId, product.productId);
    for (const reason of ['intervening', 'recost']) {
      const p = await createProduct();
      const first = await inventory(p, '10');
      const second = await inventory(p, reason === 'recost' ? undefined : '4');
      const before = await captureReplayEvidence(db().admin, owner.storeId, tables);
      const result = await correct(
        reason === 'recost' ? second.operationId : first.operationId,
      ).expect(409);
      expect(result.body).toMatchObject({ code: 'INVENTORY_CORRECTION_REQUIRES_RECOST' });
      const after = await captureReplayEvidence(db().admin, owner.storeId, tables);
      for (const table of tables) expect(after[table]).toEqual(before[table]);
      await assertInventoryReconciles(db().admin, owner.storeId, p.productId);
    }
    for (const actual of ['0', '1000']) {
      const p = await createProduct();
      const target = randomUUID();
      await request(server)
        .post('/v1/inventory/counts')
        .set(authorized())
        .send({
          operationId: target,
          countType: 'partial',
          occurredAt,
          items: [{ productId: p.productId, productUnitId: p.unitId, actualQuantityMilli: actual }],
        })
        .expect(201);
      const before = await captureReplayEvidence(db().admin, owner.storeId, tables);
      const result = await correct(target).expect(409);
      expect(result.body).toMatchObject({
        code: 'INVENTORY_CORRECTION_MISSING_PROJECTION_UNSUPPORTED',
      });
      const after = await captureReplayEvidence(db().admin, owner.storeId, tables);
      for (const table of tables) expect(after[table]).toEqual(before[table]);
      await assertInventoryReconciles(db().admin, owner.storeId, p.productId);
    }
  });

  it('S4B2-03 preserves exact conversions, int8 arithmetic and half-up residual allocation', async () => {
    const post = (p: ProductFixture, kind: string, quantity: string, cost?: string) =>
      request(server)
        .post(`/v1/inventory/${kind}`)
        .set(authorized())
        .send({
          operationId: randomUUID(),
          productId: p.productId,
          productUnitId: p.unitId,
          selectedQuantityMilli: quantity,
          occurredAt,
          reason: 'Precision proof',
          ...(cost === undefined ? {} : { totalPurchaseCostMinor: cost }),
        });
    const tables = [
      'ledger.inventory_movements',
      'ledger.stock_balances',
      'ledger.manual_inventory_entries',
    ];
    const p = await createProduct();
    await post(p, 'increase', '1000', '10').expect(201);
    const alternate = randomUUID();
    await db().admin.query(
      `insert into ledger.product_units(id,store_id,product_id,measurement_type,unit_name,is_base,factor_num,factor_den,status,operation_id)
      values($1,$2,$3,'count','alternate',false,3,2,'active',$4)`,
      [alternate, owner.storeId, p.productId, randomUUID()],
    );
    await post({ ...p, unitId: alternate }, 'increase', '2000', '30').expect(201);
    expect(await stock(p.productId)).toEqual({ quantity: '4000', value: '40', state: 'known' });
    const beforeFraction = await captureReplayEvidence(db().admin, owner.storeId, tables);
    await post({ ...p, unitId: alternate }, 'increase', '1', '1').expect(400);
    const afterFraction = await captureReplayEvidence(db().admin, owner.storeId, tables);
    for (const table of Object.keys(beforeFraction).filter(
      (table) => table !== 'sync.processed_operations',
    ))
      expect(afterFraction[table]).toEqual(beforeFraction[table]);
    await assertInventoryReconciles(db().admin, owner.storeId, p.productId);
    for (const magnitude of ['9007199254740993', '9223372036854775807']) {
      const large = await createProduct();
      const posted = await post(large, 'increase', magnitude, magnitude).expect(201);
      expect(posted.body).toMatchObject({
        stock: { baseQuantityMilli: magnitude, cost: { valueMinor: magnitude } },
      });
      expect(await stock(large.productId)).toEqual({
        quantity: magnitude,
        value: magnitude,
        state: 'known',
      });
      if (magnitude === '9223372036854775807') {
        const before = await captureReplayEvidence(db().admin, owner.storeId, tables);
        const overflow = await post(large, 'increase', '1', '1').expect(400);
        expect(overflow.body).toMatchObject({ code: 'INVENTORY_AMOUNT_INVALID' });
        const after = await captureReplayEvidence(db().admin, owner.storeId, tables);
        for (const table of tables) expect(after[table]).toEqual(before[table]);
      }
      await post(large, 'decrease', '1').expect(201);
      expect(await stock(large.productId)).toEqual({
        quantity: (BigInt(magnitude) - 1n).toString(),
        value: (BigInt(magnitude) - 1n).toString(),
        state: 'known',
      });
      await assertInventoryReconciles(db().admin, owner.storeId, large.productId);
    }
    const beyond = await createProduct();
    const beforeRange = await captureReplayEvidence(db().admin, owner.storeId, tables);
    await post(beyond, 'increase', '9223372036854775808', '1').expect(400);
    expect(await captureReplayEvidence(db().admin, owner.storeId, tables)).toEqual(beforeRange);
    const beforeConversionOverflow = await captureReplayEvidence(db().admin, owner.storeId, tables);
    expect(
      (await post({ ...p, unitId: alternate }, 'increase', '9223372036854775806', '1').expect(400))
        .body,
    ).toMatchObject({ code: 'INVENTORY_AMOUNT_INVALID' });
    const afterConversionOverflow = await captureReplayEvidence(db().admin, owner.storeId, tables);
    for (const table of tables)
      expect(afterConversionOverflow[table]).toEqual(beforeConversionOverflow[table]);
    const valueBoundary = await createProduct();
    await post(valueBoundary, 'increase', '1000', '9223372036854775807').expect(201);
    const beforeValueOverflow = await captureReplayEvidence(db().admin, owner.storeId, tables);
    expect((await post(valueBoundary, 'increase', '1000', '1').expect(400)).body).toMatchObject({
      code: 'INVENTORY_AMOUNT_INVALID',
    });
    const afterValueOverflow = await captureReplayEvidence(db().admin, owner.storeId, tables);
    for (const table of tables)
      expect(afterValueOverflow[table]).toEqual(beforeValueOverflow[table]);
    await assertInventoryReconciles(db().admin, owner.storeId, valueBoundary.productId);
    for (const [quantity, value, residual] of [
      ['3000', '1', '1'],
      ['2000', '1', '0'],
      ['3000', '2', '1'],
      ['3000', '10', '7'],
    ] as const) {
      const rounding = await createProduct();
      await post(rounding, 'increase', quantity, value).expect(201);
      await post(rounding, 'decrease', '1000').expect(201);
      const remaining = (BigInt(quantity) - 1000n).toString();
      expect(await stock(rounding.productId)).toEqual({
        quantity: remaining,
        value: residual,
        state: 'known',
      });
      await post(rounding, 'decrease', remaining).expect(201);
      expect(await stock(rounding.productId)).toEqual({
        quantity: '0',
        value: '0',
        state: 'known',
      });
      await assertInventoryReconciles(db().admin, owner.storeId, rounding.productId);
    }
  });

  it('S4B2-04 applies Product then Store negative policy across inventory families and excludes untracked stock', async () => {
    const account = await createAccount();
    const inventory = (
      p: ProductFixture,
      kind: string,
      quantity: string,
      operationId = randomUUID(),
    ) =>
      request(server)
        .post(`/v1/inventory/${kind}`)
        .set(authorized())
        .send({
          operationId,
          productId: p.productId,
          productUnitId: p.unitId,
          selectedQuantityMilli: quantity,
          occurredAt,
          reason: 'Policy proof',
        });
    const saleRequest = (p: ProductFixture) =>
      request(server)
        .post('/v1/sales')
        .set(authorized())
        .send({
          operationId: randomUUID(),
          occurredAt,
          items: [
            {
              isManualLine: false,
              productId: p.productId,
              productUnitId: p.unitId,
              quantityMilli: '1000',
              unitPriceMinor: '500',
              lineTotalMinor: '500',
            },
          ],
          payments: [{ moneyAccountId: account, amountMinor: '500' }],
          totalMinor: '500',
        });
    const tables = [
      'ledger.inventory_movements',
      'ledger.stock_balances',
      'ledger.manual_inventory_entries',
      'ledger.sales',
      'ledger.sale_returns',
      'ledger.sale_return_items',
      'ledger.sale_return_settlements',
      'ledger.money_movements',
      'ledger.customer_ledger_entries',
    ];
    try {
      for (const storePolicy of [false, true]) {
        await db().admin.query(
          'update ledger.app_settings set allow_negative_stock=$2 where store_id=$1',
          [owner.storeId, storePolicy],
        );
        for (const override of [null, false, true]) {
          const p = await createProduct();
          await db().admin.query(
            'update ledger.products set allow_negative_stock_override=$2 where id=$1',
            [p.productId, override],
          );
          const allowed = override ?? storePolicy;
          const before = await captureReplayEvidence(db().admin, owner.storeId, tables);
          const manual = await inventory(p, 'decrease', '1000').expect(allowed ? 201 : 409);
          const sale = await saleRequest(p).expect(allowed ? 201 : 409);
          if (!allowed) {
            expect(manual.body).toMatchObject({ code: 'INVENTORY_NEGATIVE_NOT_ALLOWED' });
            expect(sale.body).toMatchObject({ code: 'SALE_NEGATIVE_STOCK_NOT_ALLOWED' });
            const after = await captureReplayEvidence(db().admin, owner.storeId, tables);
            for (const table of tables) expect(after[table]).toEqual(before[table]);
          } else {
            const inboundId = randomUUID();
            await inventory(p, 'increase', '500', inboundId).expect(201);
            expect(await stock(p.productId)).toEqual({
              quantity: '-1500',
              value: '0',
              state: 'pending',
            });
            await db().admin.query(
              'update ledger.products set allow_negative_stock_override=false where id=$1',
              [p.productId],
            );
            const beforeBlocked = await captureReplayEvidence(db().admin, owner.storeId, tables);
            await inventory(p, 'increase', '1').expect(409);
            const postedSale = sale.body as SalePostingResponse;
            const blockedReturn = await postReturn(
              postedSale.sale.id,
              returnRequest(postedSale, {
                lines: [
                  {
                    saleItemId: postedSale.items[0]?.id,
                    quantityMilli: '1000',
                    disposition: 'RESTOCK_SALEABLE',
                  },
                ],
                residualSettlement: { choice: 'REFUND', moneyAccountId: account },
              }),
            ).expect(409);
            expect(blockedReturn.body).toMatchObject({ code: 'SALE_RETURN_RESTOCK_UNAVAILABLE' });
            await request(server)
              .post('/v1/inventory/corrections')
              .set(authorized())
              .send({
                operationId: randomUUID(),
                targetOperationId: inboundId,
                correctionType: 'REVERSAL',
                occurredAt,
              })
              .expect(409);
            const afterBlocked = await captureReplayEvidence(db().admin, owner.storeId, tables);
            for (const table of Object.keys(beforeBlocked).filter(
              (table) => table !== 'sync.processed_operations',
            ))
              expect(afterBlocked[table]).toEqual(beforeBlocked[table]);
          }
          await assertInventoryReconciles(db().admin, owner.storeId, p.productId);
        }
      }
      await db().admin.query('delete from ledger.app_settings where store_id=$1', [owner.storeId]);
      const fallback = await createProduct();
      expect((await inventory(fallback, 'decrease', '1000').expect(409)).body).toMatchObject({
        code: 'INVENTORY_NEGATIVE_NOT_ALLOWED',
      });
      await assertInventoryReconciles(db().admin, owner.storeId, fallback.productId);
    } finally {
      await db().admin.query(
        'insert into ledger.app_settings(store_id) values($1) on conflict(store_id) do update set allow_negative_stock=false',
        [owner.storeId],
      );
    }
    const untracked = await createProduct();
    await db().admin.query('update ledger.products set track_inventory=false where id=$1', [
      untracked.productId,
    ]);
    await inventory(untracked, 'increase', '1000').expect(409);
    await request(server)
      .post('/v1/inventory/counts')
      .set(authorized())
      .send({
        operationId: randomUUID(),
        occurredAt,
        countType: 'partial',
        items: [
          {
            productId: untracked.productId,
            productUnitId: untracked.unitId,
            actualQuantityMilli: '1000',
          },
        ],
      })
      .expect(409);
    const sale = (await saleRequest(untracked).expect(201)).body as SalePostingResponse;
    expect(sale.items[0]).toMatchObject({ costStatus: 'unknown', lineCostMinor: null });
    const returned = await postReturn(
      sale.sale.id,
      returnRequest(sale, {
        lines: [
          { saleItemId: sale.items[0]?.id, quantityMilli: '1000', disposition: 'RESTOCK_SALEABLE' },
        ],
        residualSettlement: { choice: 'REFUND', moneyAccountId: account },
      }),
    ).expect(201);
    expect(returned.body).toMatchObject({
      lines: [{ inventoryMovement: null, historicalCostMinor: null }],
    });
    await assertInventoryReconciles(db().admin, owner.storeId, untracked.productId);
  });

  it('S4B2-05 restores historical Return cost with cumulative remainders and preserves unresolved compatibility states', async () => {
    const account = await createAccount();
    const restock = (sale: SalePostingResponse, quantity = '1000') =>
      postReturn(
        sale.sale.id,
        returnRequest(sale, {
          lines: [
            {
              saleItemId: sale.items[0]?.id,
              quantityMilli: quantity,
              disposition: 'RESTOCK_SALEABLE',
            },
          ],
          residualSettlement: { choice: 'REFUND', moneyAccountId: account },
        }),
      );
    const product = await createProduct();
    await seedInventory(product, '3', '1000');
    const sale = await postTrackedSale(product, account);
    expect(sale.items[0]).toMatchObject({ costStatus: 'known', lineCostMinor: '3' });
    const historical = await captureReplayEvidence(db().admin, owner.storeId, [
      'ledger.inventory_movements',
      'ledger.sale_items',
    ]);
    await seedInventory(product, '100', '1000');
    let restored = 0n;
    let quantity = 1000n;
    for (const [part, cost] of [
      ['333', '0'],
      ['333', '1'],
      ['334', '2'],
    ] as const) {
      const returned = await restock(sale, part).expect(201);
      expect(returned.body).toMatchObject({
        lines: [
          {
            historicalCostMinor: cost,
            costStatus: 'known',
            inventoryMovement: { quantityDeltaMilli: part, valueDeltaMinor: cost },
          },
        ],
      });
      restored += BigInt(cost);
      quantity += BigInt(part);
      expect(await stock(product.productId)).toEqual({
        quantity: quantity.toString(),
        value: (100n + restored).toString(),
        state: 'known',
      });
      await assertInventoryReconciles(db().admin, owner.storeId, product.productId);
    }
    expect(restored).toBe(3n);
    const tables = [
      'ledger.inventory_movements',
      'ledger.stock_balances',
      'ledger.sale_returns',
      'ledger.sale_return_items',
    ];
    const beforeExcess = await captureReplayEvidence(db().admin, owner.storeId, tables);
    await restock(sale, '1').expect(409);
    const afterExcess = await captureReplayEvidence(db().admin, owner.storeId, tables);
    for (const table of tables) expect(afterExcess[table]).toEqual(beforeExcess[table]);
    const after = await captureReplayEvidence(db().admin, owner.storeId, [
      'ledger.inventory_movements',
      'ledger.sale_items',
    ]);
    for (const table of Object.keys(historical))
      expect(after[table]).toEqual(expect.arrayContaining(historical[table] ?? []));

    for (const state of ['zero', 'unknown', 'pending', 'estimated'] as const) {
      const p = await createProduct();
      if (state === 'pending')
        await db().admin.query(
          'update ledger.products set allow_negative_stock_override=true where id=$1',
          [p.productId],
        );
      else
        await seedInventory(
          p,
          state === 'zero' ? '0' : state === 'estimated' ? '3' : undefined,
          '1000',
        );
      const original = await postTrackedSale(p, account);
      if (state === 'estimated') {
        // Legacy compatibility fixture only; current Sale posting never emits estimated.
        await db().admin.query(
          "update ledger.sale_items set cost_status='estimated' where sale_id=$1",
          [original.sale.id],
        );
      }
      const before = await captureReplayEvidence(db().admin, owner.storeId, [
        'ledger.inventory_movements',
        'ledger.sale_items',
      ]);
      await seedInventory(p, '100', state === 'pending' ? '2000' : '1000');
      const result = await restock(original).expect(201);
      expect(result.body).toMatchObject({
        lines: [
          {
            costStatus: state === 'zero' ? 'known' : state,
            historicalCostMinor: state === 'zero' ? '0' : null,
            inventoryMovement: {
              quantityDeltaMilli: '1000',
              valueDeltaMinor: state === 'zero' ? '0' : null,
            },
          },
        ],
      });
      expect(await stock(p.productId)).toEqual({
        quantity: '2000',
        value: state === 'zero' ? '100' : '0',
        state: state === 'zero' ? 'known' : state === 'pending' ? 'pending' : 'unknown',
      });
      await assertInventoryReconciles(db().admin, owner.storeId, p.productId);
      const after = await captureReplayEvidence(db().admin, owner.storeId, [
        'ledger.inventory_movements',
        'ledger.sale_items',
      ]);
      for (const table of Object.keys(before))
        expect(after[table]).toEqual(expect.arrayContaining(before[table] ?? []));
    }
    for (const currentState of ['unknown', 'pending'] as const) {
      const p = await createProduct();
      await seedInventory(p, '3', '1000');
      const original = await postTrackedSale(p, account);
      if (currentState === 'unknown') await seedInventory(p, undefined, '1000');
      else {
        await db().admin.query(
          'update ledger.products set allow_negative_stock_override=true where id=$1',
          [p.productId],
        );
        await request(server)
          .post('/v1/inventory/decrease')
          .set(authorized())
          .send({
            operationId: randomUUID(),
            productId: p.productId,
            productUnitId: p.unitId,
            selectedQuantityMilli: '2000',
            occurredAt,
            reason: 'Later negative stock',
          })
          .expect(201);
      }
      const returned = await restock(original).expect(201);
      expect(returned.body).toMatchObject({
        lines: [{ costStatus: 'known', historicalCostMinor: '3', cogsReversalMinor: '3' }],
      });
      expect(await stock(p.productId)).toEqual({
        quantity: currentState === 'unknown' ? '2000' : '-1000',
        value: '0',
        state: currentState,
      });
      await assertInventoryReconciles(db().admin, owner.storeId, p.productId);
    }
    const damaged = await createProduct();
    await seedInventory(damaged, '3', '1000');
    const damagedSale = await postTrackedSale(damaged, account);
    const beforeDamage = await captureReplayEvidence(db().admin, owner.storeId, tables);
    const damage = await postReturn(
      damagedSale.sale.id,
      returnRequest(damagedSale, {
        residualSettlement: { choice: 'REFUND', moneyAccountId: account },
      }),
    ).expect(201);
    expect(damage.body).toMatchObject({
      lines: [{ inventoryMovement: null, cogsReversalMinor: null }],
    });
    const afterDamage = await captureReplayEvidence(db().admin, owner.storeId, tables);
    for (const table of ['ledger.inventory_movements', 'ledger.stock_balances'])
      expect(afterDamage[table]).toEqual(beforeDamage[table]);
    await assertInventoryReconciles(db().admin, owner.storeId, damaged.productId);
  });

  describe('S4E2-01 Customer Return cash basis', () => {
    const economicTables = [
      'ledger.sales',
      'ledger.sale_items',
      'ledger.sale_returns',
      'ledger.sale_return_items',
      'ledger.sale_return_settlements',
      'ledger.customer_payments',
      'ledger.customer_payment_allocations',
      'ledger.customer_ledger_entries',
      'ledger.money_movements',
      'ledger.inventory_movements',
      'ledger.stock_balances',
    ];

    async function assertDependencyRejection(
      before: Record<string, string[]>,
      operationId: unknown,
    ): Promise<void> {
      const after = await captureReplayEvidence(db().admin, owner.storeId, economicTables);
      for (const table of economicTables) expect(after[table]).toEqual(before[table]);
      expect(
        (
          await db().admin.query(
            `select status,response_body->>'code' as code from sync.processed_operations
         where store_id=$1 and operation_id=$2`,
            [owner.storeId, operationId],
          )
        ).rows,
      ).toEqual([{ status: 'rejected', code: 'SALE_RETURN_NONCASH_SETTLEMENT_DEPENDENCY' }]);
    }

    async function cancelSettlement(customerId: string, targetOperationId: string): Promise<void> {
      const before = (
        await db().admin.query(
          `select to_jsonb(e)::text as fact from ledger.customer_ledger_entries e
         where store_id=$1 and transaction_group_id=$2 order by id`,
          [owner.storeId, targetOperationId],
        )
      ).rows;
      const operationId = randomUUID();
      await request(server)
        .post(`/v1/customers/${customerId}/settlements/${targetOperationId}/cancel`)
        .set(authorized())
        .send({
          operationId,
          occurredAt,
          reason: 'Explicitly reverse noncash settlement before Return',
        })
        .expect(201);
      expect(
        (
          await db().admin.query(
            `select to_jsonb(e)::text as fact from ledger.customer_ledger_entries e
         where store_id=$1 and transaction_group_id=$2 order by id`,
            [owner.storeId, targetOperationId],
          )
        ).rows,
      ).toEqual(before);
      const inverses = (
        await db().admin.query<{ id: string; reversal_of_id: string; r: string; c: string }>(
          `select original.id, reversal.reversal_of_id,
          (original.receivable_delta_minor + reversal.receivable_delta_minor)::text as r,
          (original.credit_delta_minor + reversal.credit_delta_minor)::text as c
         from ledger.customer_ledger_entries original
         join ledger.customer_ledger_entries reversal
           on reversal.store_id=original.store_id and reversal.reversal_of_id=original.id
         where original.store_id=$1 and original.transaction_group_id=$2
           and reversal.transaction_group_id=$3`,
          [owner.storeId, targetOperationId, operationId],
        )
      ).rows;
      expect(inverses).toHaveLength(before.length);
      for (const inverse of inverses)
        expect(inverse).toMatchObject({
          reversal_of_id: inverse.id,
          r: '0',
          c: '0',
        });
    }

    const variants = [
      { name: 'A unpaid', money: 0, credit: 0, collected: 0, applied: 0, settled: 0 },
      {
        name: 'B partially collected',
        money: 0,
        credit: 0,
        collected: 200,
        applied: 0,
        settled: 0,
      },
      { name: 'C fully collected', money: 0, credit: 0, collected: 500, applied: 0, settled: 0 },
      { name: 'D original credit', money: 0, credit: 500, collected: 0, applied: 0, settled: 0 },
      {
        name: 'E later credit application',
        money: 0,
        credit: 0,
        collected: 0,
        applied: 500,
        settled: 0,
      },
      { name: 'F noncash settlement', money: 0, credit: 0, collected: 0, applied: 0, settled: 500 },
      {
        name: 'G mixed Money credit debt',
        money: 100,
        credit: 150,
        collected: 0,
        applied: 0,
        settled: 0,
      },
    ];

    it.each(variants)(
      '$name preserves Return facts without inventing cash basis',
      async (variant) => {
        const customerId = await createCustomer();
        const accountId = await createAccount();
        const advanceAccountId = await createAccount();
        const creditFunding = variant.credit + variant.applied;
        const preparationOperations: string[] = [];
        if (creditFunding > 0) {
          const operationId = randomUUID();
          preparationOperations.push(operationId);
          await request(server)
            .post(`/v1/customers/${customerId}/payments`)
            .set(authorized())
            .send({
              operationId,
              occurredAt,
              intent: 'customer_advance',
              tenders: [{ moneyAccountId: advanceAccountId, amountMinor: String(creditFunding) }],
            })
            .expect(201);
        }
        const sale = await postManualSale({
          customerId,
          ...(variant.money ? { accountId, paymentAmountMinor: String(variant.money) } : {}),
          ...(variant.credit ? { customerCreditAmountMinor: String(variant.credit) } : {}),
        });
        const original = async () =>
          (
            await db().admin.query<{ header: string; items: string | null }>(
              `select to_jsonb(s)::text as header,
            (select jsonb_agg(to_jsonb(i) order by i.id)::text
             from ledger.sale_items i where i.store_id=s.store_id and i.sale_id=s.id) as items
           from ledger.sales s where s.store_id=$1 and s.id=$2`,
              [owner.storeId, sale.sale.id],
            )
          ).rows;
        const originalFacts = await original();
        if (variant.collected > 0) {
          const operationId = randomUUID();
          preparationOperations.push(operationId);
          await request(server)
            .post(`/v1/customers/${customerId}/payments`)
            .set(authorized())
            .send({
              operationId,
              occurredAt,
              allocationMode: 'custom',
              tenders: [{ moneyAccountId: accountId, amountMinor: String(variant.collected) }],
              allocations: [
                {
                  targetType: 'sale_receivable',
                  targetId: sale.sale.id,
                  amountMinor: String(variant.collected),
                },
              ],
            })
            .expect(201);
        }
        const adjustment = variant.applied || variant.settled;
        if (adjustment > 0) {
          const operationId = randomUUID();
          preparationOperations.push(operationId);
          await request(server)
            .post(
              `/v1/customers/${customerId}/${variant.applied ? 'credit/applications' : 'settlements'}`,
            )
            .set(authorized())
            .send({
              operationId,
              occurredAt,
              amountMinor: String(adjustment),
              allocationMode: 'custom',
              allocations: [
                {
                  targetType: 'sale_receivable',
                  targetId: sale.sale.id,
                  amountMinor: String(adjustment),
                },
              ],
              ...(variant.settled ? { reason: 'S4E2-01 noncash commercial debt waiver' } : {}),
            })
            .expect(201);
        }
        const receivableBefore =
          500 - variant.money - variant.credit - variant.collected - adjustment;
        expect(await customerBalances(customerId)).toEqual({
          receivable: String(receivableBefore),
          credit: '0',
        });
        const incomingMoney = (
          await db().admin.query<{ amount: string }>(
            `select coalesce(sum(amount_delta_minor),0)::text as amount
           from ledger.money_movements where store_id=$1 and account_id=any($2::uuid[])`,
            [owner.storeId, [accountId, advanceAccountId]],
          )
        ).rows[0]?.amount;
        if (incomingMoney === undefined) throw new Error('Incoming Money total missing');
        expect(incomingMoney).toBe(String(variant.money + variant.collected + creditFunding));
        const residual = 500 - receivableBefore - variant.credit;
        const body = returnRequest(
          sale,
          residual > 0
            ? {
                residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
              }
            : {},
        );
        const before = await captureReplayEvidence(db().admin, owner.storeId, []);
        if (variant.settled > 0) {
          // Original S4E2-F01 reproduction: this request formerly committed a 500 refund
          // with zero incoming Money. The approved policy now requires rejection.
          const economicBefore = await captureReplayEvidence(
            db().admin,
            owner.storeId,
            economicTables,
          );
          expect((await postReturn(sale.sale.id, body).expect(409)).body).toMatchObject({
            code: 'SALE_RETURN_NONCASH_SETTLEMENT_DEPENDENCY',
          });
          await assertDependencyRejection(economicBefore, body.operationId);
          const settlementOperation = preparationOperations.at(-1);
          if (!settlementOperation) throw new Error('Missing noncash settlement operation');
          await cancelSettlement(customerId, settlementOperation);
          expect(await customerBalances(customerId)).toEqual({ receivable: '500', credit: '0' });
          // Rejected operations replay their rejection; retry the changed settlement
          // request as a new operation, preserving the established identity contract.
          expect((await postReturn(sale.sale.id, body).expect(409)).body).toMatchObject({
            code: 'SALE_RETURN_NONCASH_SETTLEMENT_DEPENDENCY',
          });
          const retry = returnRequest(sale);
          const posted = (await postReturn(sale.sale.id, retry).expect(201))
            .body as SaleReturnPostingResponse;
          expect(posted.settlementSummary).toEqual({
            receivableReductionMinor: '500',
            originalCustomerCreditRestorationMinor: '0',
            newCustomerCreditMinor: '0',
            refundMinor: '0',
            residualChoice: null,
          });
          expect(BigInt(posted.settlementSummary.refundMinor)).toBeLessThanOrEqual(
            BigInt(incomingMoney),
          );
          expect(await customerBalances(customerId)).toEqual({ receivable: '0', credit: '0' });
          expect(await original()).toEqual(originalFacts);
          const facts = (
            await db().admin.query(
              `select receivable_delta_minor::text as r,credit_delta_minor::text as c,
             source_sale_id,reference_id,accounting_period_id
           from ledger.customer_ledger_entries where store_id=$1 and transaction_group_id=$2`,
              [owner.storeId, posted.transactionGroupId],
            )
          ).rows;
          expect(facts).toEqual([
            {
              r: '-500',
              c: '0',
              source_sale_id: sale.sale.id,
              reference_id: posted.return.id,
              accounting_period_id: periodId,
            },
          ]);
          expect(
            (
              await db().admin.query(
                `select count(*)::int as count from ledger.money_movements
           where store_id=$1 and account_id=any($2::uuid[])`,
                [owner.storeId, [accountId, advanceAccountId]],
              )
            ).rows,
          ).toEqual([{ count: 0 }]);
          const after = await captureReplayEvidence(db().admin, owner.storeId, economicTables);
          expect((await postReturn(sale.sale.id, retry).expect(201)).body).toEqual(posted);
          expect(await captureReplayEvidence(db().admin, owner.storeId, economicTables)).toEqual(
            after,
          );
          console.info(
            'S4E2-01 FIXED F',
            JSON.stringify({
              saleId: sale.sale.id,
              rejectedOperationId: body.operationId,
              settlementOperation,
              retryOperationId: posted.operationId,
              summary: posted.settlementSummary,
              historicalFactsPreserved: true,
              refund: '0',
              receivable: '0',
              credit: '0',
            }),
          );
          return;
        }
        const response = await postReturn(sale.sale.id, body).expect(201);
        const posted = response.body as SaleReturnPostingResponse;
        expect(posted.settlementSummary).toEqual({
          receivableReductionMinor: String(receivableBefore),
          originalCustomerCreditRestorationMinor: String(variant.credit),
          refundMinor: String(residual),
          newCustomerCreditMinor: '0',
          residualChoice: residual > 0 ? 'REFUND' : null,
        });
        expect(posted.return).toMatchObject({
          saleId: sale.sale.id,
          totalMinor: '500',
          status: 'posted',
        });
        expect(posted.posting.accountingPeriodId).toBe(periodId);
        expect(posted.lines).toHaveLength(1);
        expect(posted.lines[0]).toMatchObject({
          saleItemId: sale.items[0]?.id,
          quantityMilli: '1000',
          lineRefundMinor: '500',
          inventoryMovement: null,
        });
        expect(await original()).toEqual(originalFacts);
        expect(await customerBalances(customerId)).toEqual({
          receivable: '0',
          credit: String(variant.credit),
        });
        const ledger = (
          await db().admin.query<{
            id: string;
            source_sale_id: string;
            reference_id: string;
            accounting_period_id: string;
            r: string;
            c: string;
          }>(
            `select id,source_sale_id,reference_id,accounting_period_id,
          receivable_delta_minor::text as r,credit_delta_minor::text as c
         from ledger.customer_ledger_entries where store_id=$1 and transaction_group_id=$2 order by id`,
            [owner.storeId, posted.transactionGroupId],
          )
        ).rows;
        expect(ledger.reduce((sum, row) => sum + BigInt(row.r), 0n)).toBe(
          -BigInt(receivableBefore),
        );
        expect(ledger.reduce((sum, row) => sum + BigInt(row.c), 0n)).toBe(BigInt(variant.credit));
        for (const row of ledger) {
          expect(row).toMatchObject({
            source_sale_id: sale.sale.id,
            reference_id: posted.return.id,
            accounting_period_id: periodId,
          });
        }
        const money = (
          await db().admin.query(
            `select id,account_id,reference_id,accounting_period_id,amount_delta_minor::text as amount
         from ledger.money_movements where store_id=$1 and transaction_group_id=$2 order by id`,
            [owner.storeId, posted.transactionGroupId],
          )
        ).rows;
        expect(money).toHaveLength(residual > 0 ? 1 : 0);
        if (residual > 0)
          expect(money[0]).toMatchObject({
            account_id: accountId,
            reference_id: posted.return.id,
            accounting_period_id: periodId,
            amount: String(-residual),
          });
        const settlements = (
          await db().admin.query<{
            id: string;
            amount: string;
            customer_ledger_entry_id: string | null;
            money_movement_id: string | null;
          }>(
            `select id,amount_minor::text as amount,customer_ledger_entry_id,money_movement_id
         from ledger.sale_return_settlements where store_id=$1 and sale_return_id=$2 order by id`,
            [owner.storeId, posted.return.id],
          )
        ).rows;
        expect(settlements).toHaveLength(posted.settlements.length);
        expect(settlements.reduce((sum, row) => sum + BigInt(row.amount), 0n)).toBe(500n);
        for (const settlement of posted.settlements) {
          expect(settlements).toContainEqual({
            id: settlement.id,
            amount: settlement.amountMinor,
            customer_ledger_entry_id: settlement.customerLedgerEntryId,
            money_movement_id: settlement.moneyMovement?.id ?? null,
          });
        }
        const processed = (
          await db().admin.query(
            `select status,response_body from sync.processed_operations where store_id=$1 and operation_id=$2`,
            [owner.storeId, body.operationId],
          )
        ).rows;
        expect(processed).toEqual([{ status: 'applied', response_body: posted }]);
        const tables = [
          'ledger.sale_returns',
          'ledger.sale_return_items',
          'ledger.sale_return_settlements',
          'ledger.customer_ledger_entries',
          'ledger.money_movements',
          'ledger.inventory_movements',
        ];
        const after = await captureReplayEvidence(db().admin, owner.storeId, tables);
        const eventCounts = Object.fromEntries(
          ['audit.central_audit_logs', 'sync.change_events', 'sync.store_change_events_v1'].map(
            (table) => {
              const added = (after[table] ?? []).filter(
                (row) => !(before[table] ?? []).includes(row),
              );
              expect(added.length).toBeGreaterThan(0);
              expect(added.some((row) => row.includes(posted.return.id))).toBe(true);
              return [table, added.length];
            },
          ),
        );
        expect(after['ledger.inventory_movements']).toEqual([]);
        expect((await postReturn(sale.sale.id, body).expect(201)).body).toEqual(posted);
        expect(await captureReplayEvidence(db().admin, owner.storeId, tables)).toEqual(after);
        // A full Return makes attribution exact: there is no partial-line cash allocation policy here.
        // Original credit is restored, so its backing cash is not available a second time for refund.
        const economicCashAvailable = BigInt(incomingMoney) - BigInt(variant.credit);
        console.info(
          'S4E2-01 EVIDENCE',
          JSON.stringify({
            variant,
            saleId: sale.sale.id,
            customerId,
            preparationOperations,
            returnOperationId: posted.operationId,
            transactionGroupId: posted.transactionGroupId,
            returnId: posted.return.id,
            saleValue: '500',
            receivableBefore: String(receivableBefore),
            incomingMoney,
            economicCashAvailable: economicCashAvailable.toString(),
            summary: posted.settlementSummary,
            posting: posted.posting,
            ledger,
            money,
            settlements,
            eventCounts,
            replayUnchanged: true,
          }),
        );
        // Retain this safety assertion if the owner-decision gate is reached; do not bless cash fabrication.
        expect(BigInt(posted.settlementSummary.refundMinor)).toBeLessThanOrEqual(
          economicCashAvailable,
        );
      },
    );

    it('observes a noncash settlement committed while Return waits on the Customer lock', async () => {
      if (!runtimePool) throw new Error('Runtime pool unavailable');
      const customerId = await createCustomer();
      const accountId = await createAccount();
      const sale = await postManualSale({ customerId });
      const settlementOperation = randomUUID();
      let arrived!: () => void;
      let release!: () => void;
      const atCommit = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const restore = interceptOperationQueries(
        runtimePool,
        settlementOperation,
        async (text, execute) => {
          if (text === 'commit') {
            arrived();
            await gate;
          }
          return execute();
        },
      );
      const settlement = request(server)
        .post(`/v1/customers/${customerId}/settlements`)
        .set(authorized())
        .send({
          operationId: settlementOperation,
          occurredAt,
          amountMinor: '500',
          allocationMode: 'custom',
          reason: 'S4E2-01 locked waiver',
          allocations: [
            { targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '500' },
          ],
        })
        .then((response) => response);
      const body = returnRequest(sale, {
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      });
      let pendingReturn: Promise<request.Response> | undefined;
      try {
        await Promise.race([
          atCommit,
          settlement.then(() => {
            throw new Error('Settlement missed commit gate');
          }),
        ]);
        pendingReturn = postReturn(sale.sale.id, body).then((response) => response);
        let waiting = 0;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          waiting =
            (
              await db().admin.query<{ count: number }>(
                `select count(*)::int as count from pg_stat_activity where datname=current_database()
             and application_name='dokana-s173-runtime' and wait_event_type='Lock'
             and query like '%customers%'`,
              )
            ).rows[0]?.count ?? 0;
          if (waiting > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(1);
      } finally {
        release();
        await Promise.allSettled([settlement, ...(pendingReturn ? [pendingReturn] : [])]);
        restore();
      }
      expect((await settlement).status).toBe(201);
      expect((await pendingReturn).status).toBe(409);
      expect((await pendingReturn).body).toMatchObject({
        code: 'SALE_RETURN_NONCASH_SETTLEMENT_DEPENDENCY',
      });
      expect(await customerBalances(customerId)).toEqual({ receivable: '0', credit: '0' });
      expect(
        (
          await db().admin.query(
            `select
          (select count(*)::int from ledger.sale_returns where store_id=$1 and operation_id=$2) as roots,
          (select count(*)::int from ledger.money_movements where store_id=$1 and transaction_group_id=$2) as money,
          (select count(*)::int from ledger.customer_ledger_entries where store_id=$1 and transaction_group_id=$2) as ledger,
          (select count(*)::int from ledger.inventory_movements where store_id=$1 and transaction_group_id=$2) as inventory,
          (select status from sync.processed_operations where store_id=$1 and operation_id=$2) as status`,
            [owner.storeId, body.operationId],
          )
        ).rows,
      ).toEqual([{ roots: 0, money: 0, ledger: 0, inventory: 0, status: 'rejected' }]);
    });

    it('blocks partial active settlement and replacement but preserves replay and pure reversal', async () => {
      const customerId = await createCustomer();
      const sale = await postManualSale({ customerId });
      const lines = [
        { saleItemId: sale.items[0]?.id, quantityMilli: '200', disposition: 'DAMAGED_NO_RESTOCK' },
      ];
      const firstBody = returnRequest(sale, { lines });
      const first = (await postReturn(sale.sale.id, firstBody).expect(201))
        .body as SaleReturnPostingResponse;
      const settlementOperation = randomUUID();
      await request(server)
        .post(`/v1/customers/${customerId}/settlements`)
        .set(authorized())
        .send({
          operationId: settlementOperation,
          occurredAt,
          amountMinor: '100',
          allocationMode: 'custom',
          reason: 'S4E2-01 partial waiver',
          allocations: [
            { targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '100' },
          ],
        })
        .expect(201);
      expect(await customerBalances(customerId)).toEqual({ receivable: '300', credit: '0' });
      const before = await captureReplayEvidence(db().admin, owner.storeId, economicTables);
      expect((await postReturn(sale.sale.id, firstBody).expect(201)).body).toEqual(first);
      expect(await captureReplayEvidence(db().admin, owner.storeId, economicTables)).toEqual(
        before,
      );
      const newBody = returnRequest(sale, { lines });
      expect((await postReturn(sale.sale.id, newBody).expect(409)).body).toMatchObject({
        code: 'SALE_RETURN_NONCASH_SETTLEMENT_DEPENDENCY',
      });
      await assertDependencyRejection(before, newBody.operationId);
      const replacementOperation = randomUUID();
      expect(
        (
          await request(server)
            .post(`/v1/returns/${first.return.id}/replace`)
            .set(authorized())
            .send({
              operationId: replacementOperation,
              occurredAt,
              reason: 'S4E2-01 replacement',
              replacement: { reason: 'Same quantity', lines },
            })
            .expect(409)
        ).body,
      ).toMatchObject({
        code: 'SALE_RETURN_NONCASH_SETTLEMENT_DEPENDENCY',
      });
      await assertDependencyRejection(before, replacementOperation);
      await request(server)
        .post(`/v1/returns/${first.return.id}/cancel`)
        .set(authorized())
        .send({ operationId: randomUUID(), occurredAt, reason: 'Safe historical Return reversal' })
        .expect(201);
      expect(await customerBalances(customerId)).toEqual({ receivable: '400', credit: '0' });
      // Required exact partial case: Sale 500, active settlement 100, receivable 400.
      const partialBefore = await captureReplayEvidence(db().admin, owner.storeId, economicTables);
      const partialBody = returnRequest(sale, { lines });
      await postReturn(sale.sale.id, partialBody).expect(409);
      await assertDependencyRejection(partialBefore, partialBody.operationId);
      await cancelSettlement(customerId, settlementOperation);
      expect(await customerBalances(customerId)).toEqual({ receivable: '500', credit: '0' });
      const final = (await postReturn(sale.sale.id, returnRequest(sale)).expect(201))
        .body as SaleReturnPostingResponse;
      expect(final.settlementSummary).toMatchObject({
        receivableReductionMinor: '500',
        originalCustomerCreditRestorationMinor: '0',
        newCustomerCreditMinor: '0',
        refundMinor: '0',
      });
      expect(await customerBalances(customerId)).toEqual({ receivable: '0', credit: '0' });
    });
  });

  describe('S4E2-03 Customer correction dependencies and lineage', () => {
    const tables = [
      'ledger.sales',
      'ledger.sale_items',
      'ledger.customer_payments',
      'ledger.customer_payment_allocations',
      'ledger.customer_ledger_entries',
      'ledger.money_movements',
      'ledger.sale_returns',
      'ledger.sale_return_items',
      'ledger.sale_return_settlements',
      'ledger.inventory_movements',
      'ledger.stock_balances',
      'ledger.manual_inventory_entries',
    ];
    const mutation = (path: string, body: Record<string, unknown>) =>
      request(server).post(path).set(authorized()).send(body);
    const correction = () => ({
      operationId: randomUUID(),
      occurredAt,
      reason: 'S4E2-03 linked correction',
    });
    async function rejectsUnchanged(path: string, body: Record<string, unknown>, code: string) {
      const before = await captureReplayEvidence(db().admin, owner.storeId, tables);
      expect((await mutation(path, body).expect(409)).body).toMatchObject({ code });
      const after = await captureReplayEvidence(db().admin, owner.storeId, tables);
      for (const table of tables) expect(after[table]).toEqual(before[table]);
      expect(
        (
          await db().admin.query(
            `select count(*)::int as count from sync.processed_operations
         where store_id=$1 and operation_id=$2 and status='applied'`,
            [owner.storeId, body.operationId],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    }

    it('blocks Sale correction after actual Collection or Return with zero economic effects', async () => {
      for (const dependency of ['collection', 'return']) {
        const customerId = await createCustomer();
        const sale = await postManualSale({ customerId });
        if (dependency === 'collection') {
          await mutation(`/v1/customers/${customerId}/payments`, {
            operationId: randomUUID(),
            occurredAt,
            allocationMode: 'custom',
            tenders: [{ moneyAccountId: await createAccount(), amountMinor: '100' }],
            allocations: [
              { targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '100' },
            ],
          }).expect(201);
        } else {
          await postReturn(
            sale.sale.id,
            returnRequest(sale, {
              lines: [
                {
                  saleItemId: sale.items[0]?.id,
                  quantityMilli: '200',
                  disposition: 'DAMAGED_NO_RESTOCK',
                },
              ],
            }),
          ).expect(201);
        }
        await rejectsUnchanged(
          `/v1/sales/${sale.operationId}/cancel`,
          { operationId: randomUUID(), occurredAt },
          'SALE_CORRECTION_DEPENDENT_FACTS',
        );
        expect(await customerBalances(customerId)).toEqual({ receivable: '400', credit: '0' });
      }
    });

    it('blocks reversal of consumed Collection excess and Return-created credit without losing history', async () => {
      for (const source of ['collection', 'return']) {
        const customerId = await createCustomer();
        const accountId = await createAccount();
        const sale = await postManualSale({
          customerId,
          ...(source === 'return' ? { accountId } : {}),
        });
        let path: string;
        let expectedCode: string;
        if (source === 'collection') {
          const operationId = randomUUID();
          await mutation(`/v1/customers/${customerId}/payments`, {
            operationId,
            occurredAt,
            allocationMode: 'custom',
            tenders: [{ moneyAccountId: accountId, amountMinor: '700' }],
            allocations: [
              { targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '500' },
            ],
            overpaymentHandling: 'keep_as_customer_credit',
          }).expect(201);
          path = `/v1/customers/${customerId}/payments/${operationId}/cancel`;
          expectedCode = 'CUSTOMER_FINANCIAL_CORRECTION_CREDIT_DEPENDENCY';
        } else {
          const returned = (
            await postReturn(
              sale.sale.id,
              returnRequest(sale, {
                residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
              }),
            ).expect(201)
          ).body as SaleReturnPostingResponse;
          path = `/v1/returns/${returned.return.id}/cancel`;
          expectedCode = 'SALE_RETURN_CORRECTION_CREDIT_DEPENDENCY';
        }
        await mutation(`/v1/customers/${customerId}/credit/refunds`, {
          operationId: randomUUID(),
          occurredAt,
          amountMinor: source === 'collection' ? '200' : '500',
          moneyAccountId: accountId,
        }).expect(201);
        await rejectsUnchanged(path, correction(), expectedCode);
        expect(await customerBalances(customerId)).toEqual({ receivable: '0', credit: '0' });
      }
    });

    it('preserves original refund facts and exact replacement lineage and prevents a second reversal', async () => {
      const accountId = await createAccount();
      const sale = await postManualSale({ accountId });
      const returned = (
        await postReturn(
          sale.sale.id,
          returnRequest(sale, {
            lines: [
              {
                saleItemId: sale.items[0]?.id,
                quantityMilli: '200',
                disposition: 'DAMAGED_NO_RESTOCK',
              },
            ],
            residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
          }),
        ).expect(201)
      ).body as SaleReturnPostingResponse;
      const originalRows = async () =>
        (
          await db().admin.query<{ root: string; money: string | null }>(
            `select (to_jsonb(r)-array['status','cancelled_at','updated_at','version'])::text as root,
          (select jsonb_agg(to_jsonb(m) order by m.id)::text from ledger.money_movements m
           where m.store_id=r.store_id and m.transaction_group_id=$3) as money
         from ledger.sale_returns r where r.store_id=$1 and r.id=$2`,
            [owner.storeId, returned.return.id, returned.operationId],
          )
        ).rows;
      const saved = await originalRows();
      const body = {
        ...correction(),
        replacement: {
          reason: 'S4E2-03 replacement',
          lines: [
            {
              saleItemId: sale.items[0]?.id,
              quantityMilli: '300',
              disposition: 'DAMAGED_NO_RESTOCK',
            },
          ],
          residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
        },
      };
      const response = (
        await mutation(`/v1/returns/${returned.return.id}/replace`, body).expect(201)
      ).body as SaleReturnCorrectionResponse;
      expect(response).toMatchObject({
        targetReturnId: returned.return.id,
        operationId: body.operationId,
        transactionGroupId: body.operationId,
        accountingPeriodId: periodId,
        replacement: {
          operationId: body.operationId,
          return: { saleId: sale.sale.id, totalMinor: '150' },
        },
      });
      expect(response.replacement?.return.id).not.toBe(returned.return.id);
      expect(await originalRows()).toEqual(saved);
      const originalMoneyId = returned.settlements[0]?.moneyMovement?.id;
      expect(originalMoneyId).toBeDefined();
      const money = (
        await db().admin.query(
          `select reversal_of_id,reference_id,amount_delta_minor::text as amount,
          accounting_period_id from ledger.money_movements
         where store_id=$1 and transaction_group_id=$2 order by amount_delta_minor`,
          [owner.storeId, body.operationId],
        )
      ).rows;
      expect(money).toEqual([
        {
          reversal_of_id: null,
          reference_id: response.replacement?.return.id,
          amount: '-150',
          accounting_period_id: periodId,
        },
        {
          reversal_of_id: originalMoneyId,
          reference_id: returned.return.id,
          amount: '100',
          accounting_period_id: periodId,
        },
      ]);
      const after = await captureReplayEvidence(db().admin, owner.storeId, tables);
      expect(
        (await mutation(`/v1/returns/${returned.return.id}/replace`, body).expect(201)).body,
      ).toEqual(response);
      expect(await captureReplayEvidence(db().admin, owner.storeId, tables)).toEqual(after);
      await rejectsUnchanged(
        `/v1/returns/${returned.return.id}/cancel`,
        correction(),
        'SALE_RETURN_CORRECTION_TARGET_NOT_ACTIVE',
      );
    });

    it('blocks an Inventory correction after a later movement without projection or lineage changes', async () => {
      const product = await createProduct();
      const originalOperation = randomUUID();
      const body = {
        operationId: originalOperation,
        productId: product.productId,
        productUnitId: product.unitId,
        selectedQuantityMilli: '1000',
        totalPurchaseCostMinor: '100',
        occurredAt,
      };
      await mutation('/v1/inventory/increase', body).expect(201);
      await mutation('/v1/inventory/increase', { ...body, operationId: randomUUID() }).expect(201);
      await rejectsUnchanged(
        '/v1/inventory/corrections',
        {
          operationId: randomUUID(),
          occurredAt,
          targetOperationId: originalOperation,
          correctionType: 'REVERSAL',
        },
        'INVENTORY_CORRECTION_REQUIRES_RECOST',
      );
      await assertInventoryReconciles(db().admin, owner.storeId, product.productId);
    });
  });

  describe('S4E2-02 partial Return valuation and window', () => {
    it('reconciles rounded partial mixed Returns and restores capacity through cancellation and replacement', async () => {
      const customerId = await createCustomer();
      const accountId = await createAccount();
      await request(server)
        .post(`/v1/customers/${customerId}/payments`)
        .set(authorized())
        .send({
          operationId: randomUUID(),
          occurredAt,
          intent: 'customer_advance',
          tenders: [{ moneyAccountId: accountId, amountMinor: '150' }],
        })
        .expect(201);
      const sale = await postManualSale({
        customerId,
        accountId,
        paymentAmountMinor: '100',
        customerCreditAmountMinor: '150',
      });
      const lines = (quantity: string) => [
        {
          saleItemId: sale.items[0]?.id,
          quantityMilli: quantity,
          disposition: 'DAMAGED_NO_RESTOCK',
        },
      ];
      const partial = async (quantity: string, refund = false) =>
        (
          await postReturn(
            sale.sale.id,
            returnRequest(sale, {
              lines: lines(quantity),
              ...(refund
                ? { residualSettlement: { choice: 'REFUND', moneyAccountId: accountId } }
                : {}),
            }),
          ).expect(201)
        ).body as SaleReturnPostingResponse;
      const first = await partial('333');
      expect(first.return.totalMinor).toBe('166');
      expect(first.settlementSummary).toMatchObject({
        receivableReductionMinor: '166',
        originalCustomerCreditRestorationMinor: '0',
      });
      const second = await partial('333');
      expect(second.return.totalMinor).toBe('167');
      expect(second.settlementSummary).toMatchObject({
        receivableReductionMinor: '84',
        originalCustomerCreditRestorationMinor: '83',
      });
      expect(await customerBalances(customerId)).toEqual({ receivable: '0', credit: '83' });
      await request(server)
        .post(`/v1/returns/${second.return.id}/cancel`)
        .set(authorized())
        .send({ operationId: randomUUID(), occurredAt, reason: 'S4E2-02 release capacity' })
        .expect(201);
      expect(await customerBalances(customerId)).toEqual({ receivable: '84', credit: '0' });
      const restored = await partial('333');
      expect(restored.settlementSummary).toEqual(second.settlementSummary);
      const replacement = (
        await request(server)
          .post(`/v1/returns/${restored.return.id}/replace`)
          .set(authorized())
          .send({
            operationId: randomUUID(),
            occurredAt,
            reason: 'S4E2-02 replace without double capacity',
            replacement: { reason: 'Same economic scope', lines: lines('333') },
          })
          .expect(201)
      ).body as SaleReturnCorrectionResponse;
      expect(replacement.replacement?.settlementSummary).toEqual(second.settlementSummary);
      const third = await partial('334', true);
      expect(third.return.totalMinor).toBe('167');
      expect(third.settlementSummary).toMatchObject({
        receivableReductionMinor: '0',
        originalCustomerCreditRestorationMinor: '67',
        refundMinor: '100',
        newCustomerCreditMinor: '0',
      });
      expect(await customerBalances(customerId)).toEqual({ receivable: '0', credit: '150' });
      expect(
        (
          await db().admin.query(
            `select sum(i.quantity_milli)::text as quantity,
        sum(i.line_refund_minor)::text as value from ledger.sale_return_items i
        join ledger.sale_returns r on r.store_id=i.store_id and r.id=i.sale_return_id
        where r.store_id=$1 and r.sale_id=$2 and r.status='posted'`,
            [owner.storeId, sale.sale.id],
          )
        ).rows,
      ).toEqual([{ quantity: '1000', value: '500' }]);
      expect(
        (
          await db().admin.query(
            `select sum(amount_delta_minor)::text as money from ledger.money_movements
        where store_id=$1 and account_id=$2`,
            [owner.storeId, accountId],
          )
        ).rows,
      ).toEqual([{ money: '150' }]);
      const tables = [
        'ledger.sale_returns',
        'ledger.sale_return_items',
        'ledger.sale_return_settlements',
        'ledger.customer_ledger_entries',
        'ledger.money_movements',
        'ledger.inventory_movements',
      ];
      const before = await captureReplayEvidence(db().admin, owner.storeId, tables);
      expect(
        (await postReturn(sale.sale.id, returnRequest(sale, { lines: lines('1') })).expect(409))
          .body,
      ).toMatchObject({ code: 'SALE_RETURN_QUANTITY_EXCEEDED' });
      const after = await captureReplayEvidence(db().admin, owner.storeId, tables);
      for (const table of tables) expect(after[table]).toEqual(before[table]);
    });

    it.each([-1, 0, 1])(
      'uses actual PostgreSQL transaction time at 48 hours plus %i milliseconds',
      async (offset) => {
        if (!app) throw new Error('Application unavailable');
        const accountId = await createAccount();
        const sale = await postManualSale({ accountId });
        const service = app.get(DatabaseService);
        const original = service.withBusinessWriteTransaction.bind(service);
        let observedAge: number | undefined;
        // Arrange only the disposable historical fixture before production reads it.
        // Both the arrangement and admission use the real, fixed PostgreSQL transaction clock.
        const spy = jest
          .spyOn(service, 'withBusinessWriteTransaction')
          .mockImplementation((context, work, authority) =>
            original(
              context,
              async (transaction) => {
                if (context.storeId === owner.storeId) {
                  const clock = await transaction.execute<{ at: string }>(
                    sql`select transaction_timestamp()::text as at`,
                  );
                  const clockRow = clock.rows[0];
                  if (!clockRow) throw new Error('Transaction clock missing');
                  const at = new Date(clockRow.at);
                  const sourceAt = new Date(at.getTime() - 48 * 60 * 60 * 1000 - offset);
                  await db().admin.query(
                    'update ledger.sales set sale_at=$3 where store_id=$1 and id=$2',
                    [owner.storeId, sale.sale.id, sourceAt],
                  );
                  observedAge = at.getTime() - sourceAt.getTime();
                }
                return work(transaction);
              },
              authority,
            ),
          );
        const body = returnRequest(sale, {
          residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
        });
        try {
          const result = await postReturn(sale.sale.id, body);
          expect(observedAge).toBe(48 * 60 * 60 * 1000 + offset);
          expect(result.status).toBe(offset > 0 ? 409 : 201);
          if (offset > 0) {
            expect(result.body).toMatchObject({ code: 'SALE_RETURN_WINDOW_EXPIRED' });
            expect(
              (
                await db().admin.query(
                  `select count(*)::int as count from ledger.money_movements
            where store_id=$1 and transaction_group_id=$2`,
                  [owner.storeId, body.operationId],
                )
              ).rows,
            ).toEqual([{ count: 0 }]);
          } else {
            expect((result.body as SaleReturnPostingResponse).settlementSummary.refundMinor).toBe(
              '500',
            );
          }
        } finally {
          spy.mockRestore();
        }
      },
    );

    it('does not expand cash refund when replacing an expired-window credit Return', async () => {
      const customerId = await createCustomer();
      const accountId = await createAccount();
      const sale = await postManualSale({ customerId, accountId });
      const original = (
        await postReturn(
          sale.sale.id,
          returnRequest(sale, {
            residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
          }),
        ).expect(201)
      ).body as SaleReturnPostingResponse;
      await db().admin.query(
        `update ledger.sales set sale_at=transaction_timestamp()-interval '49 hours'
        where store_id=$1 and id=$2`,
        [owner.storeId, sale.sale.id],
      );
      const tables = [
        'ledger.sale_returns',
        'ledger.sale_return_items',
        'ledger.sale_return_settlements',
        'ledger.customer_ledger_entries',
        'ledger.money_movements',
        'ledger.inventory_movements',
      ];
      const before = await captureReplayEvidence(db().admin, owner.storeId, tables);
      const replacementRequest = {
        operationId: randomUUID(),
        occurredAt,
        reason: 'S4E2-02 expired replacement',
        replacement: {
          reason: 'Change credit to cash after window',
          lines: [
            {
              saleItemId: sale.items[0]?.id,
              quantityMilli: '1000',
              disposition: 'DAMAGED_NO_RESTOCK',
            },
          ],
          residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
        },
      };
      const response = await request(server)
        .post(`/v1/returns/${original.return.id}/replace`)
        .set(authorized())
        .send(replacementRequest);
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'SALE_RETURN_CORRECTION_SCOPE_EXPANDED' });
      const after = await captureReplayEvidence(db().admin, owner.storeId, tables);
      for (const table of tables) expect(after[table]).toEqual(before[table]);
      expect(
        (
          await db().admin.query(
            `select status,error_code from sync.processed_operations
        where store_id=$1 and operation_id=$2`,
            [owner.storeId, replacementRequest.operationId],
          )
        ).rows,
      ).toEqual([{ status: 'rejected', error_code: 'SALE_RETURN_CORRECTION_SCOPE_EXPANDED' }]);
      expect(
        (
          await request(server)
            .post(`/v1/returns/${original.return.id}/replace`)
            .set(authorized())
            .send(replacementRequest)
            .expect(409)
        ).body,
      ).toMatchObject({
        code: 'SALE_RETURN_CORRECTION_SCOPE_EXPANDED',
        statusCode: 409,
        message: 'An expired Return replacement cannot expand the active Return scope.',
      });
      expect(await captureReplayEvidence(db().admin, owner.storeId, tables)).toEqual(after);
      const allowedRequest = {
        ...replacementRequest,
        operationId: randomUUID(),
        replacement: {
          ...replacementRequest.replacement,
          residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
        },
      };
      const allowed = (
        await request(server)
          .post(`/v1/returns/${original.return.id}/replace`)
          .set(authorized())
          .send(allowedRequest)
          .expect(201)
      ).body as SaleReturnCorrectionResponse;
      expect(allowed.replacement?.settlementSummary).toEqual(original.settlementSummary);
      expect(await customerBalances(customerId)).toEqual({ receivable: '0', credit: '500' });
      const successful = await captureReplayEvidence(db().admin, owner.storeId, tables);
      expect(
        (
          await request(server)
            .post(`/v1/returns/${original.return.id}/replace`)
            .set(authorized())
            .send(allowedRequest)
            .expect(201)
        ).body,
      ).toEqual(allowed);
      expect(await captureReplayEvidence(db().admin, owner.storeId, tables)).toEqual(successful);
    });
  });

  it('S4E2-06 keeps historical Sale and Collection dates consistent with PostgreSQL buckets and stored periods', async () => {
    const customerId = await createCustomer();
    const accountId = await createAccount();
    const saleAt = '2026-01-14T21:59:59.999Z';
    const paymentAt = '2026-01-14T22:00:00.000Z';
    const sale = await postManualSale({ customerId, accountId, paymentAmountMinor: '200', saleAt });
    const operationId = randomUUID();
    await request(server)
      .post(`/v1/customers/${customerId}/payments`)
      .set(authorized())
      .send({
        operationId,
        occurredAt: paymentAt,
        allocationMode: 'custom',
        tenders: [{ moneyAccountId: accountId, amountMinor: '100' }],
        allocations: [
          { targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '100' },
        ],
      })
      .expect(201);
    const payment = (
      await db().admin.query<{ id: string }>(
        `select id from ledger.customer_payments
      where store_id=$1 and customer_id=$2`,
        [owner.storeId, customerId],
      )
    ).rows[0];
    if (!payment) throw new Error('Historical Collection payment missing');
    const tables = [
      'ledger.sales',
      'ledger.customer_payments',
      'ledger.customer_ledger_entries',
      'ledger.money_movements',
      'ledger.accounting_periods',
    ];
    const before = await captureReplayEvidence(db().admin, owner.storeId, tables);
    const dates = (
      await db().admin.query<{ kind: string; date: string; period: string; contained: boolean }>(
        `
      select 'sale' as kind,(s.sale_at at time zone 'Asia/Hebron')::date::text as date,
        s.accounting_period_id as period,s.sale_at>=p.starts_at and s.sale_at<p.ends_at as contained
      from ledger.sales s join ledger.accounting_periods p on p.store_id=s.store_id and p.id=s.accounting_period_id
      where s.store_id=$1 and s.id=$2 union all
      select 'payment',(s.payment_at at time zone 'Asia/Hebron')::date::text,s.accounting_period_id,
        s.payment_at>=p.starts_at and s.payment_at<p.ends_at
      from ledger.customer_payments s join ledger.accounting_periods p on p.store_id=s.store_id and p.id=s.accounting_period_id
      where s.store_id=$1 and s.id=$3`,
        [owner.storeId, sale.sale.id, payment.id],
      )
    ).rows;
    expect(dates).toEqual([
      { kind: 'sale', date: '2026-01-14', period: sale.accountingPeriodId, contained: true },
      { kind: 'payment', date: '2026-01-15', period: sale.accountingPeriodId, contained: true },
    ]);
    const saleRead = (
      await request(server).get(`/v1/sales/${sale.sale.id}`).set(authorized()).expect(200)
    ).body as { sale: { businessDate: string; postingDate: string; accountingPeriodId: string } };
    expect(saleRead.sale).toMatchObject({
      businessDate: dates[0]?.date,
      postingDate: dates[0]?.date,
      accountingPeriodId: sale.accountingPeriodId,
    });
    const paymentRead = (
      await request(server)
        .get(`/v1/customers/${customerId}/payments/${payment.id}`)
        .set(authorized())
        .expect(200)
    ).body as {
      payment: { businessDate: string; postingDate: string; accountingPeriodId: string };
    };
    expect(paymentRead.payment).toMatchObject({
      businessDate: dates[1]?.date,
      postingDate: dates[1]?.date,
      accountingPeriodId: sale.accountingPeriodId,
    });
    const daily = (
      await request(server)
        .get('/v1/reports/daily')
        .set(authorized())
        .query({
          fromDate: '2026-01-14',
          toDate: '2026-01-15',
          accountingPeriodId: sale.accountingPeriodId,
        })
        .expect(200)
    ).body as { rows: { period: string; salesMinor: string; customerCollectionsMinor: string }[] };
    expect(daily.rows).toMatchObject([
      { period: '2026-01-14', salesMinor: '500', customerCollectionsMinor: '0' },
      { period: '2026-01-15', salesMinor: '0', customerCollectionsMinor: '100' },
    ]);
    const after = await captureReplayEvidence(db().admin, owner.storeId, tables);
    expect(after).toEqual(before);
    expect(await customerBalances(customerId)).toEqual({ receivable: '200', credit: '0' });
  });

  beforeAll(async () => {
    const environment = readLocalPostgresTestEnvironment();
    if (!environment) throw new Error('Approved non-production local test environment required.');
    database = await createInventoryTestDatabase(migrationFilename);
    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      await applyMigration(migrator, db().file);
    } finally {
      await migrator.query('reset role');
      migrator.release();
    }

    const clock = await db().admin.query<{ acceptedAt: string; businessDate: string }>(
      `select transaction_timestamp()::text as "acceptedAt",
              (transaction_timestamp() at time zone 'Asia/Hebron')::date::text as "businessDate"`,
    );
    const clockRow = clock.rows[0];
    if (!clockRow) throw new Error('PostgreSQL test clock is unavailable.');
    acceptedAt = new Date(clockRow.acceptedAt);
    occurredAt = acceptedAt.toISOString();
    const [yearText, monthText] = clockRow.businessDate.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const boundaries = resolveAccountingPeriodBoundaries(year, month);

    const uniqueStores = new Map<string, Identity>();
    for (const identity of identities) uniqueStores.set(identity.storeId, identity);
    for (const identity of uniqueStores.values()) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S17.3 fixture',$2)`,
        [identity.storeId, identity.storeStatus],
      );
      await db().admin.query(`insert into ledger.app_settings(store_id) values($1)`, [
        identity.storeId,
      ]);
      const id = deriveAccountingPeriodId(identity.storeId, year, month);
      await db().admin.query(
        `insert into ledger.accounting_periods(
          id,store_id,period_year,period_month,starts_at,ends_at,status,operation_id
        ) values($1,$2,$3,$4,$5,$6,'open',$7)`,
        [id, identity.storeId, year, month, boundaries.startsAt, boundaries.endsAt, randomUUID()],
      );
      if (identity.storeId === owner.storeId) periodId = id;
    }

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of identities) {
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S17.3 fixture')`,
        [identity.userId, identity.email, passwordHash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
         values($1,$2,$3,$4,'active')`,
        [randomUUID(), identity.storeId, identity.userId, identity.role],
      );
    }

    const databaseName = (
      await db().admin.query<{ name: string }>('select current_database() as name')
    ).rows[0]?.name;
    if (!databaseName || !/^dokana_s112_[0-9a-f]{32}$/.test(databaseName)) {
      throw new Error('S17.3 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s173-runtime', 8);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s173-auth', 3);

    await upgradeInventoryTestDatabaseToCurrent(db(), [
      ...new Set(identities.map((identity) => identity.storeId)),
    ]);
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
      const login = await request(server)
        .post('/v1/auth/login')
        .send({
          email: identity.email,
          password,
          storeId: identity.storeId,
          deviceId: identity.deviceId,
          deviceName: 'S17.3 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const token = (login.body as { accessToken?: unknown }).accessToken;
      if (typeof token !== 'string') throw new Error('S17.3 login token is missing.');
      identity.token = token;
    }
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      else await Promise.all([runtimePool?.end(), authPool?.end()]);
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

  it('Stage 3B B01 Sale Return refunds an anonymous paid Sale with one exact negative Money Movement and no debt effect', async () => {
    const accountId = await createAccount();
    const sale = await postManualSale({ accountId });
    const body = returnRequest(sale, {
      residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
    });
    const result = await postReturn(sale.sale.id, body).expect(201);
    const tables = [
      'ledger.sale_returns',
      'ledger.sale_return_items',
      'ledger.sale_return_settlements',
      'ledger.customer_ledger_entries',
      'ledger.money_movements',
      'ledger.inventory_movements',
      'ledger.stock_balances',
    ];
    const beforeReplay = await captureReplayEvidence(db().admin, owner.storeId, tables);
    expect((await postReturn(sale.sale.id, body).expect(201)).body).toEqual(result.body);
    expect(await captureReplayEvidence(db().admin, owner.storeId, tables)).toEqual(beforeReplay);
    const posted = result.body as SaleReturnPostingResponse;
    expect(posted).toMatchObject({
      operationId: body.operationId,
      return: { saleId: sale.sale.id, customerId: null, totalMinor: '500', status: 'posted' },
      settlementSummary: {
        receivableReductionMinor: '0',
        originalCustomerCreditRestorationMinor: '0',
        refundMinor: '500',
        newCustomerCreditMinor: '0',
        residualChoice: 'REFUND',
      },
      settlements: [
        {
          kind: 'money_refund',
          amountMinor: '500',
          moneyAccountId: accountId,
          moneyMovement: { movementType: 'customer_refund', amountDeltaMinor: '-500' },
        },
      ],
    });
    const facts = await db().admin.query(
      `select
        (select count(*)::int from ledger.sale_returns where store_id=$1 and operation_id=$2) as returns,
        (select count(*)::int from ledger.customer_ledger_entries where store_id=$1 and transaction_group_id=$2) as ledger,
        (select coalesce(sum(amount_delta_minor),0)::text from ledger.money_movements where store_id=$1 and transaction_group_id=$2) as money,
        (select count(*)::int from ledger.inventory_movements where store_id=$1 and transaction_group_id=$2) as inventory`,
      [owner.storeId, body.operationId],
    );
    expect(facts.rows[0]).toEqual({ returns: 1, ledger: 0, money: '-500', inventory: 0 });
    const unchangedSale = await request(server)
      .get(`/v1/sales/${sale.sale.id}`)
      .set(authorized())
      .expect(200);
    expect(unchangedSale.body).toMatchObject({
      sale: { id: sale.sale.id, status: 'posted', totalMinor: '500' },
    });
  });

  it('applies receivable-first then restores only historical Customer Credit tender', async () => {
    const customerId = await createCustomer();
    await db().admin.query(
      `insert into ledger.customer_ledger_entries(
        id,store_id,customer_id,accounting_period_id,entry_type,
        receivable_delta_minor,credit_delta_minor,reference_type,reference_id,
        transaction_group_id,occurred_at,device_id,operation_id
      ) values($1,$2,$3,$4,'credit_created',0,300,'customer_advance',$1,$5,$6,$7,$8)`,
      [
        randomUUID(),
        owner.storeId,
        customerId,
        periodId,
        randomUUID(),
        occurredAt,
        owner.deviceId,
        randomUUID(),
      ],
    );
    const sale = await postManualSale({ customerId, customerCreditAmountMinor: '300' });
    expect(await customerBalances(customerId)).toEqual({ receivable: '200', credit: '0' });

    const result = await postReturn(sale.sale.id, returnRequest(sale)).expect(201);
    expect(result.body).toMatchObject({
      settlementSummary: {
        receivableReductionMinor: '200',
        originalCustomerCreditRestorationMinor: '300',
        refundMinor: '0',
        newCustomerCreditMinor: '0',
        residualChoice: null,
      },
      settlements: [
        { kind: 'receivable_reduction', amountMinor: '200' },
        { kind: 'original_customer_credit_restoration', amountMinor: '300' },
      ],
    });
    expect(await customerBalances(customerId)).toEqual({ receivable: '0', credit: '300' });
  });

  it('handles partial Receivable reduction and explicit residual Customer Credit exactly', async () => {
    const accountId = await createAccount();

    const partialCustomer = await createCustomer();
    const partialSale = await postManualSale({
      customerId: partialCustomer,
      accountId,
      paymentAmountMinor: '300',
    });
    const partial = await postReturn(
      partialSale.sale.id,
      returnRequest(partialSale, {
        lines: [
          {
            saleItemId: partialSale.items[0]?.id,
            quantityMilli: '300',
            disposition: 'DAMAGED_NO_RESTOCK',
          },
        ],
      }),
    ).expect(201);
    expect(partial.body).toMatchObject({
      return: { totalMinor: '150' },
      settlementSummary: {
        receivableReductionMinor: '150',
        refundMinor: '0',
        newCustomerCreditMinor: '0',
      },
    });
    expect(await customerBalances(partialCustomer)).toEqual({ receivable: '50', credit: '0' });

    const residualCustomer = await createCustomer();
    const residualSale = await postManualSale({
      customerId: residualCustomer,
      accountId,
      paymentAmountMinor: '400',
    });
    const residual = await postReturn(
      residualSale.sale.id,
      returnRequest(residualSale, {
        lines: [
          {
            saleItemId: residualSale.items[0]?.id,
            quantityMilli: '500',
            disposition: 'DAMAGED_NO_RESTOCK',
          },
        ],
        residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
      }),
    ).expect(201);
    expect(residual.body).toMatchObject({
      return: { totalMinor: '250' },
      settlementSummary: {
        receivableReductionMinor: '100',
        refundMinor: '0',
        newCustomerCreditMinor: '150',
        residualChoice: 'KEEP_AS_CUSTOMER_CREDIT',
      },
    });
    expect(await customerBalances(residualCustomer)).toEqual({ receivable: '0', credit: '150' });

    const paidCustomer = await createCustomer();
    const paidSale = await postManualSale({ customerId: paidCustomer, accountId });
    await postReturn(
      paidSale.sale.id,
      returnRequest(paidSale, {
        lines: [
          {
            saleItemId: paidSale.items[0]?.id,
            quantityMilli: '400',
            disposition: 'DAMAGED_NO_RESTOCK',
          },
        ],
        residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
      }),
    ).expect(201);
    expect(await customerBalances(paidCustomer)).toEqual({ receivable: '0', credit: '200' });
  });

  it('Stage 3B B01 Sale Return restocks saleable tracked quantity at historical known/unknown cost and never restocks damage', async () => {
    const accountId = await createAccount();
    const known = await createProduct();
    await seedInventory(known, '200');
    const knownSale = await postTrackedSale(known, accountId);
    expect(await stock(known.productId)).toEqual({
      quantity: '1000',
      value: '100',
      state: 'known',
    });
    const knownBody = returnRequest(knownSale, {
      lines: [
        {
          saleItemId: knownSale.items[0]?.id,
          quantityMilli: '1000',
          disposition: 'RESTOCK_SALEABLE',
        },
      ],
      residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
    });
    const knownReturn = await postReturn(knownSale.sale.id, knownBody).expect(201);
    const tables = [
      'ledger.sale_returns',
      'ledger.sale_return_items',
      'ledger.sale_return_settlements',
      'ledger.customer_ledger_entries',
      'ledger.money_movements',
      'ledger.inventory_movements',
      'ledger.stock_balances',
    ];
    const beforeReplay = await captureReplayEvidence(db().admin, owner.storeId, tables);
    expect((await postReturn(knownSale.sale.id, knownBody).expect(201)).body).toEqual(
      knownReturn.body,
    );
    expect(await captureReplayEvidence(db().admin, owner.storeId, tables)).toEqual(beforeReplay);
    expect(knownReturn.body).toMatchObject({
      lines: [
        {
          costStatus: 'known',
          historicalCostMinor: '100',
          cogsReversalMinor: '100',
          inventoryMovement: { quantityDeltaMilli: '1000', valueDeltaMinor: '100' },
        },
      ],
    });
    expect(await stock(known.productId)).toEqual({
      quantity: '2000',
      value: '200',
      state: 'known',
    });

    const damagedSale = await postTrackedSale(known, accountId);
    const damaged = await postReturn(
      damagedSale.sale.id,
      returnRequest(damagedSale, {
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    ).expect(201);
    expect(damaged.body).toMatchObject({
      lines: [{ itemCondition: 'damaged', cogsReversalMinor: null, inventoryMovement: null }],
    });
    expect(await stock(known.productId)).toEqual({
      quantity: '1000',
      value: '100',
      state: 'known',
    });

    const unknown = await createProduct();
    await seedInventory(unknown);
    const unknownSale = await postTrackedSale(unknown, accountId);
    const unknownResult = await postReturn(
      unknownSale.sale.id,
      returnRequest(unknownSale, {
        lines: [
          {
            saleItemId: unknownSale.items[0]?.id,
            quantityMilli: '1000',
            disposition: 'RESTOCK_SALEABLE',
          },
        ],
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    ).expect(201);
    expect(unknownResult.body).toMatchObject({
      lines: [
        {
          costStatus: 'unknown',
          historicalCostMinor: null,
          cogsReversalMinor: null,
          inventoryMovement: { valueDeltaMinor: null },
        },
      ],
    });
    expect(await stock(unknown.productId)).toEqual({
      quantity: '2000',
      value: '0',
      state: 'unknown',
    });
  });

  it('replays exactly, rejects changed identity, and serializes competing over-returns', async () => {
    const customerId = await createCustomer();
    const sale = await postManualSale({ customerId });
    const body = returnRequest(sale);
    const [first, duplicate] = await Promise.all([
      postReturn(sale.sale.id, body),
      postReturn(sale.sale.id, body),
    ]);
    expect([first.status, duplicate.status]).toEqual([201, 201]);
    expect(duplicate.body).toEqual(first.body);
    expect(
      (await postReturn(sale.sale.id, { ...body, reason: 'Changed request' }).expect(409)).body,
    ).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });

    const competingSale = await postManualSale({ customerId: await createCustomer() });
    const responses = await Promise.all([
      postReturn(competingSale.sale.id, returnRequest(competingSale)),
      postReturn(competingSale.sale.id, returnRequest(competingSale)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body).toMatchObject({
      code: 'SALE_RETURN_QUANTITY_EXCEEDED',
    });
    const count = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.sale_returns
       where store_id=$1 and sale_id=$2 and status='posted'`,
      [owner.storeId, competingSale.sale.id],
    );
    expect(count.rows[0]).toEqual({ count: 1 });
    expect(
      (
        await request(server)
          .post(`/v1/sales/${sale.operationId}/cancel`)
          .set(authorized())
          .send({ operationId: randomUUID(), occurredAt })
          .expect(409)
      ).body,
    ).toMatchObject({ code: 'SALE_CORRECTION_DEPENDENT_FACTS' });
  });

  it('rejects a new Return when the current S9 posting period is closed', async () => {
    const accountId = await createAccount();
    const sale = await postManualSale({ accountId });
    const body = returnRequest(sale, {
      residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
    });
    await db().admin.query(
      `update ledger.accounting_periods
       set status='closed',closed_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, periodId],
    );
    try {
      expect((await postReturn(sale.sale.id, body).expect(409)).body).toMatchObject({
        code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
      });
    } finally {
      await db().admin.query(
        `update ledger.accounting_periods set status='open',closed_at=null
         where store_id=$1 and id=$2`,
        [owner.storeId, periodId],
      );
    }
    const facts = await db().admin.query(
      `select
        (select count(*)::int from ledger.sale_returns where store_id=$1 and operation_id=$2) as returns,
        (select count(*)::int from ledger.money_movements where store_id=$1 and transaction_group_id=$2) as money,
        (select status from sync.processed_operations where store_id=$1 and operation_id=$2) as status`,
      [owner.storeId, body.operationId],
    );
    expect(facts.rows[0]).toEqual({ returns: 0, money: 0, status: 'rejected' });
  });

  it('fails closed for authentication, actor role, tenant RLS, read_only, expiry, and inactive Sales', async () => {
    const customerId = await createCustomer();
    const sale = await postManualSale({ customerId });
    const body = returnRequest(sale);
    await request(server).post(`/v1/sales/${sale.sale.id}/return`).send(body).expect(401);
    await postReturn(sale.sale.id, body, manager).expect(403);
    expect((await postReturn(sale.sale.id, body, foreignOwner).expect(404)).body).toMatchObject({
      code: 'SALE_RETURN_SALE_NOT_FOUND',
    });
    await postReturn(sale.sale.id, body, readOnlyOwner).expect(403);

    const expiredSale = await postManualSale({
      customerId: await createCustomer(),
      saleAt: new Date(acceptedAt.getTime() - 49 * 60 * 60 * 1000).toISOString(),
    });
    expect(
      (await postReturn(expiredSale.sale.id, returnRequest(expiredSale)).expect(409)).body,
    ).toMatchObject({ code: 'SALE_RETURN_WINDOW_EXPIRED' });

    const inactiveSale = await postManualSale({ customerId: await createCustomer() });
    await request(server)
      .post(`/v1/sales/${inactiveSale.operationId}/cancel`)
      .set(authorized())
      .send({ operationId: randomUUID(), occurredAt })
      .expect(201);
    expect(
      (await postReturn(inactiveSale.sale.id, returnRequest(inactiveSale)).expect(409)).body,
    ).toMatchObject({ code: 'SALE_RETURN_SALE_INACTIVE' });

    const accountId = await createAccount();
    const archivedCustomer = await createCustomer();
    const archivedSale = await postManualSale({ customerId: archivedCustomer, accountId });
    await db().admin.query(
      `update ledger.customers set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, archivedCustomer],
    );
    expect(
      (
        await postReturn(
          archivedSale.sale.id,
          returnRequest(archivedSale, {
            residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
          }),
        ).expect(409)
      ).body,
    ).toMatchObject({ code: 'SALE_RETURN_CUSTOMER_RESTORE_REQUIRED' });
    await postReturn(
      archivedSale.sale.id,
      returnRequest(archivedSale, {
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    ).expect(201);

    const historicalCreditCustomer = await createCustomer();
    const historicalCreditId = randomUUID();
    await db().admin.query(
      `insert into ledger.customer_ledger_entries(
        id,store_id,customer_id,accounting_period_id,entry_type,
        receivable_delta_minor,credit_delta_minor,reference_type,reference_id,
        transaction_group_id,occurred_at,device_id,operation_id
      ) values($1,$2,$3,$4,'credit_created',0,100,'customer_advance',$1,$5,$6,$7,$8)`,
      [
        historicalCreditId,
        owner.storeId,
        historicalCreditCustomer,
        periodId,
        randomUUID(),
        occurredAt,
        owner.deviceId,
        randomUUID(),
      ],
    );
    const historicalCreditSale = await postManualSale({
      customerId: historicalCreditCustomer,
      accountId,
      paymentAmountMinor: '400',
      customerCreditAmountMinor: '100',
    });
    await db().admin.query(
      `update ledger.customers set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, historicalCreditCustomer],
    );
    const historicalCreditReturn = await postReturn(
      historicalCreditSale.sale.id,
      returnRequest(historicalCreditSale, {
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    ).expect(201);
    expect(historicalCreditReturn.body).toMatchObject({
      settlementSummary: {
        originalCustomerCreditRestorationMinor: '100',
        refundMinor: '400',
        newCustomerCreditMinor: '0',
      },
    });
    expect(await customerBalances(historicalCreditCustomer)).toEqual({
      receivable: '0',
      credit: '100',
    });
  });

  it('serializes Return against collection, Sale correction, refund-account archive, and Product archive', async () => {
    const collectionAccount = await createAccount();
    const collectionCustomer = await createCustomer();
    const collectionSale = await postManualSale({ customerId: collectionCustomer });
    const collectionRace = await Promise.all([
      postReturn(collectionSale.sale.id, returnRequest(collectionSale)),
      request(server)
        .post(`/v1/customers/${collectionCustomer}/payments`)
        .set(authorized())
        .send({
          operationId: randomUUID(),
          occurredAt,
          allocationMode: 'fifo',
          tenders: [{ moneyAccountId: collectionAccount, amountMinor: '500' }],
        }),
    ]);
    expect(collectionRace.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await customerBalances(collectionCustomer)).toEqual({ receivable: '0', credit: '0' });

    const correctionCustomer = await createCustomer();
    const correctionSale = await postManualSale({ customerId: correctionCustomer });
    const correctionRace = await Promise.all([
      postReturn(correctionSale.sale.id, returnRequest(correctionSale)),
      request(server)
        .post(`/v1/sales/${correctionSale.operationId}/cancel`)
        .set(authorized())
        .send({ operationId: randomUUID(), occurredAt }),
    ]);
    expect(correctionRace.map((response) => response.status).sort()).toEqual([201, 409]);

    const paidAccount = await createAccount();
    const refundAccount = await createAccount();
    const refundSale = await postManualSale({ accountId: paidAccount });
    const refundRace = await Promise.all([
      postReturn(
        refundSale.sale.id,
        returnRequest(refundSale, {
          residualSettlement: { choice: 'REFUND', moneyAccountId: refundAccount },
        }),
      ),
      request(server)
        .post(`/v1/money-accounts/${refundAccount}/archive`)
        .set(authorized())
        .send({ operationId: randomUUID(), expectedVersion: '1' }),
    ]);
    expect(refundRace.filter((response) => response.status < 300)).toHaveLength(1);
    expect(refundRace.filter((response) => response.status === 409)).toHaveLength(1);

    const product = await createProduct();
    await seedInventory(product, '100', '1000');
    const productSale = await postTrackedSale(product, paidAccount);
    expect(await stock(product.productId)).toEqual({ quantity: '0', value: '0', state: 'known' });
    const productRace = await Promise.all([
      postReturn(
        productSale.sale.id,
        returnRequest(productSale, {
          lines: [
            {
              saleItemId: productSale.items[0]?.id,
              quantityMilli: '1000',
              disposition: 'RESTOCK_SALEABLE',
            },
          ],
          residualSettlement: { choice: 'REFUND', moneyAccountId: paidAccount },
        }),
      ),
      request(server)
        .post(`/v1/products/${product.productId}/archive`)
        .set(authorized())
        .send({ operationId: randomUUID(), expectedVersion: '1' }),
    ]);
    expect(productRace.filter((response) => response.status < 300)).toHaveLength(1);
    expect(productRace.filter((response) => response.status === 409)).toHaveLength(1);

    const creditCustomer = await createCustomer();
    const creditAccount = await createAccount();
    const creditSeedId = randomUUID();
    await db().admin.query(
      `insert into ledger.customer_ledger_entries(
        id,store_id,customer_id,accounting_period_id,entry_type,
        receivable_delta_minor,credit_delta_minor,reference_type,reference_id,
        transaction_group_id,occurred_at,device_id,operation_id
      ) values($1,$2,$3,$4,'credit_created',0,100,'customer_advance',$1,$5,$6,$7,$8)`,
      [
        creditSeedId,
        owner.storeId,
        creditCustomer,
        periodId,
        randomUUID(),
        occurredAt,
        owner.deviceId,
        randomUUID(),
      ],
    );
    const creditSale = await postManualSale({
      customerId: creditCustomer,
      accountId: paidAccount,
      paymentAmountMinor: '400',
      customerCreditAmountMinor: '100',
    });
    const creditRace = await Promise.all([
      postReturn(
        creditSale.sale.id,
        returnRequest(creditSale, {
          residualSettlement: { choice: 'REFUND', moneyAccountId: paidAccount },
        }),
      ),
      request(server)
        .post(`/v1/customers/${creditCustomer}/credit/refunds`)
        .set(authorized())
        .send({
          operationId: randomUUID(),
          occurredAt,
          amountMinor: '100',
          moneyAccountId: creditAccount,
        }),
    ]);
    expect(creditRace[0].status).toBe(201);
    expect([201, 409]).toContain(creditRace[1].status);
    const creditBalance = await customerBalances(creditCustomer);
    expect(creditBalance.receivable).toBe('0');
    expect(['0', '100']).toContain(creditBalance.credit);
  });

  it('rolls back every Return fact when restock eligibility changes and records successful audit/change effects', async () => {
    const accountId = await createAccount();
    const product = await createProduct();
    await seedInventory(product, '200');
    const sale = await postTrackedSale(product, accountId);
    await db().admin.query(
      `update ledger.products set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, product.productId],
    );
    const body = returnRequest(sale, {
      lines: [
        {
          saleItemId: sale.items[0]?.id,
          quantityMilli: '1000',
          disposition: 'RESTOCK_SALEABLE',
        },
      ],
      residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
    });
    expect((await postReturn(sale.sale.id, body).expect(409)).body).toMatchObject({
      code: 'SALE_RETURN_RESTOCK_UNAVAILABLE',
    });
    const rejected = await db().admin.query(
      `select
        (select count(*)::int from ledger.sale_returns where store_id=$1 and operation_id=$2) as returns,
        (select count(*)::int from ledger.inventory_movements where store_id=$1 and transaction_group_id=$2) as inventory,
        (select count(*)::int from ledger.money_movements where store_id=$1 and transaction_group_id=$2) as money,
        (select status from sync.processed_operations where store_id=$1 and operation_id=$2) as status`,
      [owner.storeId, body.operationId],
    );
    expect(rejected.rows[0]).toEqual({ returns: 0, inventory: 0, money: 0, status: 'rejected' });

    const successfulSale = await postManualSale({ customerId: await createCustomer() });
    const success = await postReturn(successfulSale.sale.id, returnRequest(successfulSale)).expect(
      201,
    );
    const returnId = (success.body as SaleReturnPostingResponse).return.id;
    const evidence = await db().admin.query(
      `select
        (select count(*)::int from audit.central_audit_logs where store_id=$1 and entity_id=$2) as audit,
        (select count(*)::int from sync.change_events where store_id=$1 and entity_id=$2) as changes`,
      [owner.storeId, returnId],
    );
    expect(evidence.rows[0]).toEqual({ audit: 2, changes: 2 });
  });
});
