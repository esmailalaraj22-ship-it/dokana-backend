import { randomUUID } from 'node:crypto';
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
import type { AuthenticationResponse, SyncAuthenticationResponse } from '../src/auth/auth.types';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import type { DashboardResponse } from '../src/dashboard/dashboard.types';
import type { OfflineLicenseResponse } from '../src/offline-licenses/offline-license.types';
import type { OfflineOperationPushResult } from '../src/sync/offline-operation.contract';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
  upgradeInventoryTestDatabaseToCurrent,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0028_offline_operation_recovery_authority.sql';
const environment = readLocalPostgresTestEnvironment();
const describeWithPostgres = environment ? describe : describe.skip;

interface Identity {
  storeId: string;
  userId: string;
  deviceId: string;
  email: string;
  role: 'owner' | 'manager';
  token: string;
}

interface FixtureClock {
  now: Date;
  dayStart: Date;
  previousDay: Date;
  businessDate: string;
}

interface OfflinePushResponse {
  results: OfflineOperationPushResult[];
}

const identities: [Identity, Identity, Identity, Identity] = [
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s202-owner-${randomUUID()}@example.test`,
    role: 'owner',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s202-foreign-${randomUUID()}@example.test`,
    role: 'owner',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s202-manager-${randomUUID()}@example.test`,
    role: 'manager',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s202-readonly-${randomUUID()}@example.test`,
    role: 'owner',
    token: '',
  },
];

const owner = identities[0];
const foreignOwner = identities[1];
const manager = identities[2];
const readOnlyOwner = identities[3];
const ids = {
  cash: randomUUID(),
  bank: randomUUID(),
  foreignCash: randomUUID(),
  readOnlyCash: randomUUID(),
  customer: randomUUID(),
  foreignCustomer: randomUUID(),
  supplier: randomUUID(),
  knownProduct: randomUUID(),
  knownUnit: randomUUID(),
  unknownProduct: randomUUID(),
  unknownUnit: randomUUID(),
  missingProduct: randomUUID(),
  missingUnit: randomUUID(),
};

describeWithPostgres('S20.2 Dashboard authoritative Store reads', () => {
  jest.setTimeout(300_000);

  let database: InventoryTestDatabase | undefined;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let clock: FixtureClock;
  let periodId: string;
  let login: AuthenticationResponse;
  let syncAuthentication: SyncAuthenticationResponse;
  let license: OfflineLicenseResponse;
  const password = `S20.2-${randomUUID()}!`;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('The isolated S20.2 database is unavailable.');
    return database;
  }

  async function dashboard(identity: Identity = owner): Promise<DashboardResponse> {
    const response = await request(server)
      .get('/v1/dashboard')
      .set('authorization', `Bearer ${identity.token}`)
      .expect(200);
    return response.body as DashboardResponse;
  }

  async function insertMoneyMovement(input: {
    storeId?: string;
    accountId?: string;
    amountMinor: string;
    occurredAt?: Date;
    movementType?: string;
  }): Promise<void> {
    const storeId = input.storeId ?? owner.storeId;
    const accountingPeriodId = derivePeriodId(storeId, input.occurredAt ?? clock.now);
    await db().admin.query(
      `insert into ledger.money_movements(
        id, store_id, account_id, accounting_period_id, movement_type,
        amount_delta_minor, reference_type, reference_id, transaction_group_id,
        occurred_at, operation_id
      ) values($1,$2,$3,$4,$5,$6,'dashboard_fixture',$7,$8,$9,$10)`,
      [
        randomUUID(),
        storeId,
        input.accountId ?? ids.cash,
        accountingPeriodId,
        input.movementType ?? 'opening_balance',
        input.amountMinor,
        randomUUID(),
        randomUUID(),
        input.occurredAt ?? clock.now,
        randomUUID(),
      ],
    );
  }

  function derivePeriodId(storeId: string, occurredAt: Date): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Hebron',
      year: 'numeric',
      month: 'numeric',
    }).formatToParts(occurredAt);
    const year = Number(parts.find((part) => part.type === 'year')?.value);
    const month = Number(parts.find((part) => part.type === 'month')?.value);
    return deriveAccountingPeriodId(storeId, year, month);
  }

  async function seedIdentityFoundation(): Promise<void> {
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of identities) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S20.2 fixture','active')`,
        [identity.storeId],
      );
      await db().admin.query(`insert into ledger.app_settings(store_id) values($1)`, [
        identity.storeId,
      ]);
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name,status)
         values($1,$2,$2,$3,'S20.2 fixture','active')`,
        [identity.userId, identity.email, passwordHash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
         values($1,$2,$3,$4,'active')`,
        [randomUUID(), identity.storeId, identity.userId, identity.role],
      );
    }
  }

  async function seedPeriods(): Promise<void> {
    for (const identity of identities) {
      const local = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Hebron',
        year: 'numeric',
        month: 'numeric',
      }).formatToParts(clock.now);
      const year = Number(local.find((part) => part.type === 'year')?.value);
      const month = Number(local.find((part) => part.type === 'month')?.value);
      const boundaries = resolveAccountingPeriodBoundaries(year, month);
      await db().admin.query(
        `insert into ledger.accounting_periods(
          id,store_id,period_year,period_month,starts_at,ends_at,status,operation_id
        ) values($1,$2,$3,$4,$5,$6,'open',$7)`,
        [
          deriveAccountingPeriodId(identity.storeId, year, month),
          identity.storeId,
          year,
          month,
          boundaries.startsAt,
          boundaries.endsAt,
          randomUUID(),
        ],
      );
    }
    periodId = derivePeriodId(owner.storeId, clock.now);
  }

  async function seedCatalogAndBalances(): Promise<void> {
    for (const [id, identity, name, type] of [
      [ids.cash, owner, 'Cash', 'cash'],
      [ids.bank, owner, 'Bank', 'transfer'],
      [ids.foreignCash, foreignOwner, 'Foreign Cash', 'cash'],
      [ids.readOnlyCash, readOnlyOwner, 'Read Only Cash', 'cash'],
    ] as const) {
      await db().admin.query(
        `insert into ledger.money_accounts(
          id,store_id,name,normalized_name,account_type,availability,is_default,status,device_id,operation_id
        ) values($1,$2,$3,lower($3),$4,'available',$5,'active',$6,$7)`,
        [id, identity.storeId, name, type, type === 'cash', identity.deviceId, randomUUID()],
      );
    }
    await db().admin.query(
      `insert into ledger.customers(
        id,store_id,name,normalized_name,phone,normalized_phone,status,device_id,operation_id
      ) values($1,$2,'Dashboard Customer','dashboard customer','0599000202','+970599000202',
          'active',$3,$4),
        ($5,$6,'Foreign Customer','foreign customer','0599000203','+970599000203',
          'active',$7,$8)`,
      [
        ids.customer,
        owner.storeId,
        owner.deviceId,
        randomUUID(),
        ids.foreignCustomer,
        foreignOwner.storeId,
        foreignOwner.deviceId,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.suppliers(
        id,store_id,name,normalized_name,status,device_id,operation_id
      ) values($1,$2,'Dashboard Supplier','dashboard supplier','active',$3,$4)`,
      [ids.supplier, owner.storeId, owner.deviceId, randomUUID()],
    );
    for (const [productId, unitId, name] of [
      [ids.knownProduct, ids.knownUnit, 'Known Product'],
      [ids.unknownProduct, ids.unknownUnit, 'Unknown Product'],
      [ids.missingProduct, ids.missingUnit, 'Missing Projection Product'],
    ] as const) {
      await db().admin.query(
        `insert into ledger.products(
          id,store_id,name,normalized_name,measurement_type,track_inventory,status,device_id,operation_id
        ) values($1,$2,$3,lower($3),'count',true,'active',$4,$5)`,
        [productId, owner.storeId, name, owner.deviceId, randomUUID()],
      );
      await db().admin.query(
        `insert into ledger.product_units(
          id,store_id,product_id,measurement_type,unit_name,is_base,factor_num,factor_den,
          status,device_id,operation_id
        ) values($1,$2,$3,'count','piece',true,1,1,'active',$4,$5)`,
        [unitId, owner.storeId, productId, owner.deviceId, randomUUID()],
      );
    }

    await insertMoneyMovement({ amountMinor: '9007199254740000' });
    await insertMoneyMovement({ amountMinor: '100', movementType: 'sale_payment' });
    await insertMoneyMovement({ amountMinor: '200', movementType: 'customer_payment' });
    await insertMoneyMovement({ amountMinor: '-400', movementType: 'supplier_payment' });
    await insertMoneyMovement({
      storeId: foreignOwner.storeId,
      accountId: ids.foreignCash,
      amountMinor: '8000000000000000000',
    });

    await db().admin.query(
      `insert into ledger.customer_ledger_entries(
        id,store_id,customer_id,accounting_period_id,entry_type,receivable_delta_minor,
        credit_delta_minor,reference_type,reference_id,transaction_group_id,occurred_at,operation_id
      ) values
        ($1,$2,$3,$4,'opening_balance',900,0,'opening_receivable',$5,$6,$7,$8),
        ($9,$2,$3,$4,'payment',-150,0,'customer_payment',$10,$11,$7,$12),
        ($13,$2,$3,$4,'credit_created',0,50,'customer_payment',$10,$11,$7,$14)`,
      [
        randomUUID(),
        owner.storeId,
        ids.customer,
        periodId,
        randomUUID(),
        randomUUID(),
        clock.now,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.customer_ledger_entries(
        id,store_id,customer_id,accounting_period_id,entry_type,receivable_delta_minor,
        credit_delta_minor,reference_type,reference_id,transaction_group_id,occurred_at,operation_id
      ) values($1,$2,$3,$4,'opening_balance',7000000000000000000,0,
        'opening_receivable',$5,$6,$7,$8)`,
      [
        randomUUID(),
        foreignOwner.storeId,
        ids.foreignCustomer,
        derivePeriodId(foreignOwner.storeId, clock.now),
        randomUUID(),
        randomUUID(),
        clock.now,
        randomUUID(),
      ],
    );

    await db().admin.query(
      `insert into ledger.supplier_ledger_entries(
        id,store_id,supplier_id,accounting_period_id,entry_type,payable_delta_minor,
        credit_delta_minor,reference_type,reference_id,transaction_group_id,occurred_at,operation_id
      ) values
        ($1,$2,$3,$4,'supplier_invoice',1000,0,'supplier_invoice',$5,$6,$7,$8),
        ($9,$2,$3,$4,'payment',-400,0,'supplier_payment',$10,$11,$7,$12)`,
      [
        randomUUID(),
        owner.storeId,
        ids.supplier,
        periodId,
        randomUUID(),
        randomUUID(),
        clock.now,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );

    const inventoryMovementId = randomUUID();
    await db().admin.query(
      `insert into ledger.inventory_movements(
        id,store_id,product_id,accounting_period_id,movement_type,quantity_before_milli,
        quantity_delta_milli,quantity_after_milli,inventory_value_before_minor,value_delta_minor,
        inventory_value_after_minor,average_unit_cost_after_minor,cost_status,has_pending_cost_after,
        reference_type,reference_id,transaction_group_id,occurred_at,operation_id,product_unit_id,
        selected_quantity_milli,factor_num,factor_den,business_date,posting_date,cost_state_before,
        cost_state_after,quantity_fact_kind
      ) values($1,$2,$3,$4,'adjustment_in',0,9007199254740993,9007199254740993,
        0,0,0,0,'unknown',false,'dashboard_fixture',$5,$6,$7,$8,$9,
        9007199254740993,1,1,$10,$10,'unknown','unknown','movement')`,
      [
        inventoryMovementId,
        owner.storeId,
        ids.unknownProduct,
        periodId,
        randomUUID(),
        randomUUID(),
        new Date(clock.dayStart.getTime() + 40_000),
        randomUUID(),
        ids.unknownUnit,
        clock.businessDate,
      ],
    );
    await db().admin.query(
      `insert into ledger.stock_balances(
        store_id,product_id,quantity_milli,average_unit_cost_minor,inventory_value_minor,
        has_pending_cost,last_movement_id,version,cost_state
      ) values
        ($1,$2,5000,1801439850948,9007199254740991,false,null,1,'known'),
        ($1,$3,9007199254740993,0,0,false,$4,1,'unknown')`,
      [owner.storeId, ids.knownProduct, ids.unknownProduct, inventoryMovementId],
    );
  }

  async function seedTodayAndActivity(): Promise<string> {
    const saleIds: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const saleId = randomUUID();
      saleIds.push(saleId);
      const total = index === 0 ? '100' : index === 1 ? '9007199254740993' : '1';
      await insertSale({
        id: saleId,
        totalMinor: total,
        occurredAt: new Date(clock.dayStart.getTime() + (index + 1) * 1000),
        displayNumber: `S20-TODAY-${String(index).padStart(2, '0')}`,
        status: 'posted',
      });
    }
    await insertSale({
      id: randomUUID(),
      totalMinor: '999',
      occurredAt: clock.previousDay,
      displayNumber: 'S20-PREVIOUS-DAY',
      status: 'posted',
    });
    await insertSale({
      id: randomUUID(),
      totalMinor: '888',
      occurredAt: new Date(clock.dayStart.getTime() + 25_000),
      displayNumber: 'S20-CORRECTED',
      status: 'corrected',
    });
    await insertSale({
      id: randomUUID(),
      totalMinor: '50',
      occurredAt: new Date(clock.dayStart.getTime() + 26_000),
      displayNumber: 'S20-REPLACEMENT',
      status: 'posted',
    });
    await insertSale({
      id: randomUUID(),
      storeId: foreignOwner.storeId,
      totalMinor: '6000000000000000000',
      occurredAt: new Date(clock.dayStart.getTime() + 27_000),
      displayNumber: 'S20-FOREIGN',
      status: 'posted',
    });

    await db().admin.query(
      `insert into ledger.sale_payments(
        id,store_id,sale_id,money_account_id,amount_minor,payment_at,money_movement_id
      ) values($1,$2,$3,$4,100,$5,null)`,
      [randomUUID(), owner.storeId, saleIds[0], ids.cash, clock.now],
    );
    await db().admin.query(
      `insert into ledger.customer_payments(
        id,store_id,customer_id,accounting_period_id,money_account_id,amount_minor,
        allocated_total_minor,credit_created_minor,payment_at,status,device_id,operation_id
      ) values($1,$2,$3,$4,$5,200,150,50,$6,'posted',$7,$8)`,
      [
        randomUUID(),
        owner.storeId,
        ids.customer,
        periodId,
        ids.cash,
        clock.now,
        owner.deviceId,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.purchase_invoices(
        id,store_id,supplier_id,display_number,invoice_date_at,items_subtotal_minor,
        total_minor,status,device_id,operation_id,accounting_period_id,posting_date
      ) values($1,$2,$3,'S20-PI-1',$4,1000,1000,'open',$5,$6,$7,$8)`,
      [
        randomUUID(),
        owner.storeId,
        ids.supplier,
        clock.now,
        owner.deviceId,
        randomUUID(),
        periodId,
        clock.businessDate,
      ],
    );
    const supplierMovement = (
      await db().admin.query<{ id: string }>(
        `select id from ledger.money_movements
         where store_id=$1 and movement_type='supplier_payment' order by occurred_at desc limit 1`,
        [owner.storeId],
      )
    ).rows[0]?.id;
    if (!supplierMovement) throw new Error('Supplier payment movement fixture is missing.');
    await db().admin.query(
      `insert into ledger.supplier_payments(
        id,store_id,supplier_id,accounting_period_id,amount_minor,allocated_total_minor,
        credit_created_minor,payment_source,money_account_id,money_movement_id,payment_at,
        status,device_id,operation_id
      ) values($1,$2,$3,$4,400,400,0,'money_account',$5,$6,$7,'posted',$8,$9)`,
      [
        randomUUID(),
        owner.storeId,
        ids.supplier,
        periodId,
        ids.cash,
        supplierMovement,
        clock.now,
        owner.deviceId,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.expenses(
        id,store_id,accounting_period_id,description,amount_minor,paid_total_minor,
        expense_at,payment_timing,status,device_id,operation_id
      ) values($1,$2,$3,'Dashboard expense',300,0,$4,'due_later','posted',$5,$6)`,
      [randomUUID(), owner.storeId, periodId, clock.now, owner.deviceId, randomUUID()],
    );
    const firstSaleId = saleIds[0];
    if (!firstSaleId) throw new Error('The first Dashboard Sale fixture is missing.');
    return firstSaleId;
  }

  async function insertSale(input: {
    id: string;
    totalMinor: string;
    occurredAt: Date;
    displayNumber: string;
    status: 'posted' | 'corrected';
    storeId?: string;
  }): Promise<void> {
    const storeId = input.storeId ?? owner.storeId;
    await db().admin.query(
      `insert into ledger.sales(
        id,store_id,accounting_period_id,display_number,sale_at,items_subtotal_minor,
        total_minor,paid_total_minor,credit_total_minor,payment_status,status,device_id,operation_id
      ) values($1,$2,$3,$4,$5,$6,$6,$6,0,'paid',$7,$8,$9)`,
      [
        input.id,
        storeId,
        derivePeriodId(storeId, input.occurredAt),
        input.displayNumber,
        input.occurredAt,
        input.totalMinor,
        input.status,
        storeId === owner.storeId ? owner.deviceId : foreignOwner.deviceId,
        randomUUID(),
      ],
    );
  }

  beforeAll(async () => {
    if (!environment) throw new Error('Approved non-production local PostgreSQL is required.');
    database = await createInventoryTestDatabase(migrationFilename);
    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      await applyMigration(migrator, db().file);
    } finally {
      await migrator.query('reset role');
      migrator.release();
    }
    const databaseName = (
      await db().admin.query<{ name: string }>('select current_database() as name')
    ).rows[0]?.name;
    if (!databaseName || !/^dokana_s112_[0-9a-f]{32}$/.test(databaseName)) {
      throw new Error('The S20.2 integration database is not isolated.');
    }
    const localDatabaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(
      localDatabaseUrl(environment.runtimeUrl),
      'dokana-s202-runtime',
      8,
    );
    authPool = createTestPool(localDatabaseUrl(environment.authUrl), 'dokana-s202-auth', 2);

    const time = await db().admin.query<FixtureClock>(
      `select
        clock_timestamp() as now,
        ((clock_timestamp() at time zone 'Asia/Hebron')::date::timestamp
          at time zone 'Asia/Hebron') as "dayStart",
        (((clock_timestamp() at time zone 'Asia/Hebron')::date::timestamp
          at time zone 'Asia/Hebron') - interval '1 millisecond') as "previousDay",
        (clock_timestamp() at time zone 'Asia/Hebron')::date::text as "businessDate"`,
    );
    const fixtureClock = time.rows[0];
    if (!fixtureClock) throw new Error('The S20.2 fixture clock is unavailable.');
    clock = fixtureClock;

    await seedIdentityFoundation();
    await upgradeInventoryTestDatabaseToCurrent(
      db(),
      identities.map((identity) => identity.storeId),
    );
    await seedPeriods();

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
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
          deviceName: 'S20.2 isolated device',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = response.body as AuthenticationResponse;
      identity.token = body.accessToken;
      if (identity === owner) login = body;
    }

    license = (
      await request(server)
        .post('/v1/licenses/verify')
        .set('authorization', `Bearer ${owner.token}`)
        .send({ operationId: randomUUID() })
        .expect(200)
    ).body as OfflineLicenseResponse;
    syncAuthentication = (
      await request(server)
        .post('/v1/sync/auth/token')
        .send({ refreshToken: login.refreshToken })
        .expect(200)
    ).body as SyncAuthenticationResponse;

    await seedCatalogAndBalances();
    await seedTodayAndActivity();
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

  it('returns exact authoritative metrics, Store-local today, unknown valuation, and bounded activity', async () => {
    const response = await dashboard();
    expect(response).toMatchObject({
      timezoneName: 'Asia/Hebron',
      businessDate: clock.businessDate,
      today: {
        salesMinor: '9007199254741162',
        immediateSaleCollectionsMinor: '100',
        customerCollectionsMinor: '200',
        customerReceivableAllocationsMinor: '150',
        totalCollectedMinor: '300',
        creditSalesMinor: '0',
        expensesRecognizedMinor: '300',
        supplierPaymentsMinor: '400',
      },
      money: {
        totalMinor: '9007199254739900',
        accounts: [
          {
            id: ids.cash,
            accountType: 'cash',
            balanceMinor: '9007199254739900',
          },
          { id: ids.bank, accountType: 'transfer', balanceMinor: '0' },
        ],
      },
      obligations: {
        customerReceivablesMinor: '700',
        supplierPayablesMinor: '600',
      },
      inventory: {
        trackedProductCount: 3,
        projectedProductCount: 2,
        missingProjectionCount: 1,
        positiveStockProductCount: 2,
        knownCostProductCount: 1,
        unknownCostProductCount: 1,
        knownValueMinor: '9007199254740991',
        totalValueMinor: null,
        valuationStatus: 'partial',
      },
      recentActivity: { limit: 20 },
    });
    expect(response.recentActivity.items).toHaveLength(20);
    expect(response.recentActivity.items).toContainEqual(
      expect.objectContaining({
        activityType: 'inventory_movement',
        quantityDeltaMilli: '9007199254740993',
        amountMinor: null,
      }),
    );
    for (let index = 1; index < response.recentActivity.items.length; index += 1) {
      const previous = response.recentActivity.items[index - 1];
      const current = response.recentActivity.items[index];
      if (!previous || !current) throw new Error('Recent activity ordering fixture is incomplete.');
      expect(previous.occurredAt >= current.occurredAt).toBe(true);
    }
  });

  it('preserves owner authorization, READ_ONLY access, RLS fail-closed behavior, and Store isolation', async () => {
    await request(server)
      .get('/v1/dashboard')
      .set('authorization', `Bearer ${manager.token}`)
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'DASHBOARD_READ_NOT_ALLOWED' });
      });

    const ownerResponse = await request(server)
      .get('/v1/dashboard')
      .query({ storeId: foreignOwner.storeId })
      .set('authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect((ownerResponse.body as DashboardResponse).money.totalMinor).toBe('9007199254739900');

    await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
      readOnlyOwner.storeId,
    ]);
    await expect(dashboard(readOnlyOwner)).resolves.toMatchObject({
      today: { salesMinor: '0' },
    });

    const withoutContext = await db().runtime.query<{ count: number }>(
      'select count(*)::integer as count from ledger.sales',
    );
    expect(withoutContext.rows[0]).toEqual({ count: 0 });
  });

  it('keeps a complete Dashboard response on one repeatable-read snapshot during a concurrent commit', async () => {
    const before = await dashboard();
    const lockClient = await db().admin.connect();
    let lockOpen = false;
    try {
      await lockClient.query('begin');
      lockOpen = true;
      await lockClient.query('lock table ledger.money_movements in access exclusive mode');

      const pending = dashboard();
      await waitForMoneyQueryLock(db().admin);
      await insertSale({
        id: randomUUID(),
        totalMinor: '77',
        occurredAt: clock.now,
        displayNumber: `S20-CONCURRENT-${randomUUID()}`,
        status: 'posted',
      });
      await lockClient.query('commit');
      lockOpen = false;

      const during = await pending;
      expect(during.today.salesMinor).toBe(before.today.salesMinor);
      expect(during.money.totalMinor).toBe(before.money.totalMinor);

      const after = await dashboard();
      expect(after.today.salesMinor).toBe((BigInt(before.today.salesMinor) + 77n).toString());
      expect(after.money.totalMinor).toBe(before.money.totalMinor);
    } finally {
      if (lockOpen) await lockClient.query('rollback');
      lockClient.release();
    }
  });

  it('reports equivalent online and offline-originated canonical Sales without a separate read path', async () => {
    const before = await dashboard();
    const originClock = await db().admin.query<{ occurredAt: Date }>(
      'select clock_timestamp() as "occurredAt"',
    );
    const occurredAt = originClock.rows[0]?.occurredAt.toISOString();
    if (!occurredAt) throw new Error('The origin-neutral Sale clock is unavailable.');
    const onlineOperationId = randomUUID();
    await request(server)
      .post('/v1/sales')
      .set('authorization', `Bearer ${owner.token}`)
      .send(saleBody(onlineOperationId, occurredAt))
      .expect(201);
    const afterOnline = await dashboard();
    expect(afterOnline.today.salesMinor).toBe((BigInt(before.today.salesMinor) + 321n).toString());
    expect(afterOnline.today.immediateSaleCollectionsMinor).toBe(
      (BigInt(before.today.immediateSaleCollectionsMinor) + 321n).toString(),
    );
    expect(afterOnline.money.totalMinor).toBe((BigInt(before.money.totalMinor) + 321n).toString());

    const offlineOperationId = randomUUID();
    const signed = license.license;
    const operation = {
      protocolVersion: 1,
      operationId: offlineOperationId,
      operationType: 'sales.post.v1',
      storeId: owner.storeId,
      deviceId: owner.deviceId,
      clientRecordedAt: occurredAt,
      payload: saleBody(null, occurredAt),
      offlineLicenseId: signed.payload.licenseId,
      signedLicense: signed,
      signingKeyId: signed.payload.signingKeyId,
      subscriptionId: signed.payload.subscriptionId,
      subscriptionVersion: signed.payload.subscriptionVersion,
      trustedTimeEvidence: {
        version: 1,
        trustedServerTime: signed.payload.issuedAt,
        observedDeviceTime: occurredAt,
        clockState: 'trusted',
        knownStoreStatus: 'active',
        knownStoreStatusAt: signed.payload.issuedAt,
      },
      localSequence: '1',
      dependsOnOperationIds: [],
    };
    const push = await request(server)
      .post('/v1/sync/push')
      .set('authorization', `Bearer ${syncAuthentication.syncToken}`)
      .send({ operations: [operation] })
      .expect(200);
    const pushResult = (push.body as OfflinePushResponse).results[0];
    if (pushResult?.status !== 'APPLIED') {
      throw new Error(
        `Offline Dashboard fixture was not applied: ${pushResult?.status ?? 'missing'} / ${pushResult?.code ?? 'missing'}`,
      );
    }
    expect(pushResult).toMatchObject({
      operationId: offlineOperationId,
      status: 'APPLIED',
    });

    const afterOffline = await dashboard();
    expect(afterOffline.today.salesMinor).toBe(
      (BigInt(afterOnline.today.salesMinor) + 321n).toString(),
    );
    expect(afterOffline.today.immediateSaleCollectionsMinor).toBe(
      (BigInt(afterOnline.today.immediateSaleCollectionsMinor) + 321n).toString(),
    );
    expect(afterOffline.money.totalMinor).toBe(
      (BigInt(afterOnline.money.totalMinor) + 321n).toString(),
    );
    expect(
      afterOffline.recentActivity.items.filter(
        (item) => item.activityType === 'sale' && item.amountMinor === '321',
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  function saleBody(operationId: string | null, occurredAt: string): Record<string, unknown> {
    return {
      ...(operationId ? { operationId } : {}),
      occurredAt,
      totalMinor: '321',
      items: [
        {
          isManualLine: true,
          description: 'Dashboard origin-neutral sale',
          unitName: 'service',
          quantityMilli: '1000',
          unitPriceMinor: '321',
          lineTotalMinor: '321',
        },
      ],
      payments: [{ moneyAccountId: ids.cash, amountMinor: '321' }],
    };
  }
});

async function waitForMoneyQueryLock(pool: Pool): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ blocked: boolean }>(
      `select exists(
        select 1 from pg_stat_activity
        where datname=current_database()
          and wait_event_type='Lock'
          and query ilike '%v_money_account_balances%'
      ) as blocked`,
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The Dashboard money query did not reach the expected relation lock.');
}
