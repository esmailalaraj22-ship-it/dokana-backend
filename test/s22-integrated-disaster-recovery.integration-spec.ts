import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import { protectAttachmentRecoveryPoint } from '../scripts/recovery/attachment-recovery-job';
import { readAttachmentRecoveryEntries } from '../scripts/recovery/attachment-recovery-files';
import { readVerifiedMigrationState } from '../scripts/recovery/migration-state';
import { resolvePostgresToolchain } from '../scripts/recovery/postgres-tools';
import { RecoveryExecutionService } from '../scripts/recovery/recovery-execution';
import { createVerifiedRecoveryPoint } from '../scripts/recovery/recovery-point-job';
import { readRecoveryControl, withDatabase } from '../scripts/recovery/recovery-target';
import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import {
  ATTACHMENT_MALWARE_SCANNER,
  type AttachmentMalwareScannerPort,
  type AttachmentScanResult,
} from '../src/attachments/attachment-malware-scanner.port';
import {
  ATTACHMENT_STORAGE,
  type AttachmentObjectPage,
  type AttachmentStoragePort,
  type PutAttachmentObjectInput,
  type StoredAttachmentObject,
} from '../src/attachments/attachment-storage.port';
import { ATTACHMENT_MAX_BYTES } from '../src/attachments/attachment.types';
import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import type { AuthenticationResponse, SyncAuthenticationResponse } from '../src/auth/auth.types';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import { NotificationSchedulerService } from '../src/notifications/notification-scheduler.service';
import type { OfflineLicenseResponse } from '../src/offline-licenses/offline-license.types';
import { deriveTransactionGroupId } from '../src/money-movements/money-movement-identity';
import { FilesystemRecoveryArtifactStorage } from '../src/recovery/filesystem-recovery-artifact-storage';
import type { RecoveryRuntimeConfig } from '../src/recovery/recovery-config';
import type { SalePostingResponse } from '../src/sales/sale-posting.types';
import { BOOTSTRAP_ARTIFACT_ROOT } from '../src/sync/bootstrap-artifact.store';
import type { BootstrapManifest } from '../src/sync/bootstrap.types';
import { SyncCursorService } from '../src/sync/sync-cursor.service';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
  upgradeInventoryTestDatabaseToCurrent,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0033_platform_recovery_generation_fencing.sql';
const environment = readLocalPostgresTestEnvironment();
const describeWithPostgres = environment ? describe : describe.skip;

jest.setTimeout(600_000);

interface Identity {
  storeId: string;
  userId: string;
  membershipId: string;
  deviceId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

interface AppHarness {
  app: INestApplication;
  server: Server;
  runtimePool: Pool;
  authPool: Pool;
}

interface AccountingSnapshot {
  receivable: string;
  payable: string;
  money: string;
  inventory: string;
  sales: string;
  collections: string;
  invoices: string;
  supplierPayments: string;
  expenses: string;
  expensePayments: string;
  returns: string;
  ownerEntries: string;
  notifications: string;
  audits: string;
  activeAttachments: string;
  removedAttachments: string;
}

class NullLogDestination implements DestinationStream {
  write(): void {
    return;
  }
}

class DrillAttachmentStorage implements AttachmentStoragePort {
  readonly objects = new Map<string, { body: Buffer; lastModified: Date }>();

  set(key: string, body: Buffer): void {
    this.objects.set(key, { body: Buffer.from(body), lastModified: new Date() });
  }

  corruptExistingObject(key: string): void {
    const existing = this.objects.get(key);
    if (!existing) throw new Error('Attachment fault injection requires an existing object.');
    const body = Buffer.from(existing.body);
    body[0] = (body[0] ?? 0) ^ 0xff;
    this.objects.set(key, { body, lastModified: new Date() });
  }

  putObject(input: PutAttachmentObjectInput): Promise<void> {
    this.set(input.key, input.body);
    return Promise.resolve();
  }

  getObject(key: string): Promise<StoredAttachmentObject | null> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object ? { body: Buffer.from(object.body), contentLength: object.body.byteLength } : null,
    );
  }

  deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  objectExists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }

  listObjects(input: {
    prefix: string;
    limit: number;
    continuationToken: string | null;
  }): Promise<AttachmentObjectPage> {
    const matches = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(input.prefix))
      .filter(([key]) => input.continuationToken === null || key > input.continuationToken)
      .sort(([left], [right]) => left.localeCompare(right, 'en'));
    const page = matches.slice(0, input.limit);
    return Promise.resolve({
      objects: page.map(([key, value]) => ({ key, lastModified: value.lastModified })),
      nextToken: matches.length > input.limit ? (page.at(-1)?.[0] ?? null) : null,
    });
  }
}

class DrillAttachmentScanner implements AttachmentMalwareScannerPort {
  scan(): Promise<AttachmentScanResult> {
    return Promise.resolve('clean');
  }
}

function body(response: Response): Record<string, unknown> {
  if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body)) {
    throw new Error('Expected an object response body.');
  }
  return response.body as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string') throw new Error(`Expected ${field} to be a string.`);
  return result;
}

function nestedId(value: Record<string, unknown>, field: string): string {
  const nested = value[field];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
    throw new Error(`Expected ${field} to be an object.`);
  }
  return stringField(nested as Record<string, unknown>, 'id');
}

function authorization(identity: Identity): Record<string, string> {
  return { authorization: `Bearer ${identity.accessToken}` };
}

function connectionFor(source: string, databaseName: string): string {
  const parsed = new URL(source);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

async function createHarness(input: {
  databaseName: string;
  attachmentStorage: AttachmentStoragePort;
  bootstrapRoot: string;
}): Promise<AppHarness> {
  if (!environment) throw new Error('Approved local PostgreSQL environment is unavailable.');
  process.env.APP_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = connectionFor(environment.runtimeUrl, input.databaseName);
  process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
  process.env.AUTH_DATABASE_URL = connectionFor(environment.authUrl, input.databaseName);
  process.env.REQUEST_ID_TRUST_INCOMING = 'true';
  const runtimePool = createTestPool(process.env.DATABASE_URL, 'dokana-s225-runtime', 10);
  const authPool = createTestPool(process.env.AUTH_DATABASE_URL, 'dokana-s225-auth', 4);
  const { AppModule } = await import('../src/app.module');
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DATABASE_POOL)
    .useValue(runtimePool)
    .overrideProvider(AUTH_DATABASE_POOL)
    .useValue(authPool)
    .overrideProvider(ATTACHMENT_STORAGE)
    .useValue(input.attachmentStorage)
    .overrideProvider(ATTACHMENT_MALWARE_SCANNER)
    .useValue(new DrillAttachmentScanner())
    .overrideProvider(BOOTSTRAP_ARTIFACT_ROOT)
    .useValue(input.bootstrapRoot)
    .overrideProvider(PARAMS_PROVIDER_TOKEN)
    .useFactory({
      factory: (config: AppConfigService) => createLoggingParams(config, new NullLogDestination()),
      inject: [AppConfigService],
    })
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
  app.useLogger(app.get(Logger));
  configureApplication(app, app.get(AppConfigService));
  await app.init();
  app.get(NotificationSchedulerService).onModuleDestroy();
  return { app, server: app.getHttpServer(), runtimePool, authPool };
}

async function closeHarness(harness: AppHarness | undefined): Promise<void> {
  if (!harness) return;
  await harness.app.close();
}

async function login(server: Server, identity: Identity, password: string): Promise<void> {
  const response = await request(server)
    .post('/v1/auth/login')
    .send({
      email: identity.email,
      password,
      storeId: identity.storeId,
      deviceId: identity.deviceId,
      deviceName: 'S22.5 recovery drill',
      devicePlatform: 'android',
    })
    .expect(200);
  const authentication = body(response) as unknown as AuthenticationResponse;
  identity.accessToken = authentication.accessToken;
  identity.refreshToken = authentication.refreshToken;
}

async function accountingSnapshot(pool: Pool, storeId: string): Promise<AccountingSnapshot> {
  const result = await pool.query<AccountingSnapshot>(
    `select
       (select coalesce(sum(receivable_delta_minor-credit_delta_minor),0)::text
        from ledger.customer_ledger_entries where store_id=$1) as receivable,
       (select coalesce(sum(payable_delta_minor-credit_delta_minor),0)::text
        from ledger.supplier_ledger_entries where store_id=$1) as payable,
       (select coalesce(sum(amount_delta_minor),0)::text
        from ledger.money_movements where store_id=$1) as money,
       (select coalesce(sum(quantity_delta_milli),0)::text
        from ledger.inventory_movements where store_id=$1) as inventory,
       (select count(*)::text from ledger.sales where store_id=$1) as sales,
       (select count(*)::text from ledger.customer_payments where store_id=$1) as collections,
       (select count(*)::text from ledger.purchase_invoices where store_id=$1) as invoices,
       (select count(*)::text from ledger.supplier_payments where store_id=$1)
         as "supplierPayments",
       (select count(*)::text from ledger.expenses where store_id=$1) as expenses,
       (select count(*)::text from ledger.expense_payments where store_id=$1)
         as "expensePayments",
       (select count(*)::text from ledger.sale_returns where store_id=$1) as returns,
       (select count(*)::text from ledger.owner_ledger_entries where store_id=$1)
         as "ownerEntries",
       (select count(*)::text from ledger.notifications where store_id=$1) as notifications,
       (select count(*)::text from audit.central_audit_logs where store_id=$1) as audits,
       (select count(*)::text from ledger.attachments where store_id=$1 and removed_at is null)
         as "activeAttachments",
       (select count(*)::text from ledger.attachments where store_id=$1 and removed_at is not null)
         as "removedAttachments"`,
    [storeId],
  );
  const snapshot = result.rows[0];
  if (!snapshot) throw new Error('Accounting snapshot is unavailable.');
  return snapshot;
}

async function assertAccountingViews(pool: Pool, storeId: string): Promise<void> {
  const result = await pool.query<{
    customers: boolean;
    suppliers: boolean;
    money: boolean;
    expenses: boolean;
    inventory: boolean;
  }>(
    `select
       not exists (
         select 1 from ledger.v_customer_balances balance
         where balance.store_id=$1 and balance.net_due_minor < 0
       ) as customers,
       not exists (
         select 1 from ledger.v_supplier_balances balance
         where balance.store_id=$1 and balance.net_payable_minor < 0
       ) as suppliers,
       not exists (
         select 1 from ledger.v_money_account_balances balance
         where balance.store_id=$1
           and balance.balance_minor <> (
             select coalesce(sum(movement.amount_delta_minor), 0)
             from ledger.money_movements movement
             where movement.store_id=balance.store_id
               and movement.account_id=balance.account_id
           )
       ) as money,
       not exists (
         select 1 from ledger.v_expense_balances balance
         where balance.store_id=$1
           and (balance.paid_minor < 0 or balance.due_minor < 0
             or balance.paid_minor + balance.due_minor <> balance.amount_minor)
       ) as expenses,
       not exists (
         select 1
         from ledger.stock_balances balance
         where balance.store_id=$1
           and balance.quantity_milli <> (
             select coalesce(sum(movement.quantity_delta_milli),0)
             from ledger.inventory_movements movement
             where movement.store_id=balance.store_id
               and movement.product_id=balance.product_id
           )
       ) as inventory`,
    [storeId],
  );
  expect(result.rows[0]).toEqual({
    customers: true,
    suppliers: true,
    money: true,
    expenses: true,
    inventory: true,
  });
}

describeWithPostgres('S22.5 integrated disaster-recovery drill', () => {
  it('restores one coherent authority and rejects every stale pre-cutover authority', async () => {
    if (!environment) throw new Error('Approved local PostgreSQL environment is unavailable.');

    const originalEnvironment = {
      APP_ENV: process.env.APP_ENV,
      LOG_LEVEL: process.env.LOG_LEVEL,
      DATABASE_URL: process.env.DATABASE_URL,
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      AUTH_DATABASE_URL: process.env.AUTH_DATABASE_URL,
      REQUEST_ID_TRUST_INCOMING: process.env.REQUEST_ID_TRUST_INCOMING,
    };
    const drillStartedAt = new Date();
    const recoveryRoot = await mkdtemp(join(tmpdir(), 'dokana-s225-recovery-'));
    const sourceBootstrapRoot = await mkdtemp(join(tmpdir(), 'dokana-s225-source-bootstrap-'));
    const targetBootstrapRoot = await mkdtemp(join(tmpdir(), 'dokana-s225-target-bootstrap-'));
    const recoveryStorage = new FilesystemRecoveryArtifactStorage(recoveryRoot);
    const sourceAttachmentStorage = new DrillAttachmentStorage();
    const targetAttachmentStorage = new DrillAttachmentStorage();
    let database: InventoryTestDatabase | undefined;
    let sourceApp: AppHarness | undefined;
    let targetApp: AppHarness | undefined;
    let targetDatabaseName: string | null = null;
    let recoveryPointCreatedAt: string | null = null;
    let disasterAt: string | null = null;
    let recoveryStartedAt: string | null = null;
    let databaseRestoredAt: string | null = null;
    let attachmentsRestoredAt: string | null = null;
    let verifiedAt: string | null = null;
    let activatedAt: string | null = null;
    let bootstrapCompletedAt: string | null = null;
    let firstBusinessOperationAt: string | null = null;

    const ownerA: Identity = {
      storeId: randomUUID(),
      userId: randomUUID(),
      membershipId: randomUUID(),
      deviceId: randomUUID(),
      email: `s225-owner-a-${randomUUID()}@example.test`,
      accessToken: '',
      refreshToken: '',
    };
    const ownerB: Identity = {
      storeId: randomUUID(),
      userId: randomUUID(),
      membershipId: randomUUID(),
      deviceId: randomUUID(),
      email: `s225-owner-b-${randomUUID()}@example.test`,
      accessToken: '',
      refreshToken: '',
    };
    const fixture = {
      customerA: randomUUID(),
      customerB: randomUUID(),
      supplierA: randomUUID(),
      supplierB: randomUUID(),
      productA: randomUUID(),
      productB: randomUUID(),
      unitA: randomUUID(),
      unitB: randomUUID(),
      cashAccount: randomUUID(),
      bankAccount: randomUUID(),
      cashAccountB: randomUUID(),
      expenseCategory: randomUUID(),
      preExpense: randomUUID(),
      postExpense: randomUUID(),
    };
    const password = `S225-${randomUUID()}!Aa1`;

    try {
      database = await createInventoryTestDatabase(migrationFilename);
      const migration = await database.migration.connect();
      try {
        await verifyMigrationSession(migration);
        await applyMigration(migration, database.file);
      } finally {
        await migration.query('reset role');
        migration.release();
      }

      const passwordHash = await new PasswordService().hash(password);
      for (const [storeId, name] of [
        [ownerA.storeId, 'S22.5 Drill Store A'],
        [ownerB.storeId, 'S22.5 Drill Store B'],
      ] as const) {
        await database.admin.query(
          `insert into ledger.stores(id,name,status) values($1,$2,'active')`,
          [storeId, name],
        );
        await database.admin.query(`insert into ledger.app_settings(store_id) values($1)`, [
          storeId,
        ]);
      }
      for (const identity of [ownerA, ownerB]) {
        await database.admin.query(
          `insert into platform.users(
             id,email,normalized_email,password_hash,full_name,status
           ) values($1,$2,$2,$3,$4,'active')`,
          [identity.userId, identity.email, passwordHash, identity.email.split('@')[0]],
        );
        await database.admin.query(
          `insert into platform.store_memberships(id,store_id,user_id,role,status)
           values($1,$2,$3,'owner','active')`,
          [identity.membershipId, identity.storeId, identity.userId],
        );
      }
      await upgradeInventoryTestDatabaseToCurrent(database, [ownerA.storeId, ownerB.storeId]);

      const clock = await database.admin.query<{ occurredAt: string; businessDate: string }>(
        `select clock_timestamp()::text as "occurredAt",
                (clock_timestamp() at time zone 'Asia/Hebron')::date::text as "businessDate"`,
      );
      const occurredAt = new Date(stringField(clock.rows[0] ?? {}, 'occurredAt')).toISOString();
      const [yearText, monthText] = stringField(clock.rows[0] ?? {}, 'businessDate').split('-');
      const year = Number(yearText);
      const month = Number(monthText);
      const boundaries = resolveAccountingPeriodBoundaries(year, month);
      for (const storeId of [ownerA.storeId, ownerB.storeId]) {
        await database.admin.query(
          `insert into ledger.accounting_periods(
             id,store_id,period_year,period_month,starts_at,ends_at,status,operation_id
           ) values($1,$2,$3,$4,$5,$6,'open',$7)`,
          [
            deriveAccountingPeriodId(storeId, year, month),
            storeId,
            year,
            month,
            boundaries.startsAt,
            boundaries.endsAt,
            randomUUID(),
          ],
        );
      }
      await database.admin.query(
        `update ledger.app_settings
         set customer_debt_amount_alert_minor=100,
             debt_age_alert_days=36500,
             low_stock_alert_enabled=true
         where store_id=$1`,
        [ownerA.storeId],
      );
      await database.admin.query(
        `insert into ledger.customers(
           id,store_id,name,normalized_name,phone,normalized_phone,credit_limit_minor,
           status,operation_id
         ) values
           ($1,$3,'S22.5 Customer A','s22.5 customer a','0599002201','+970599002201',100000,'active',$5),
           ($2,$4,'S22.5 Customer B','s22.5 customer b','0599002202','+970599002202',100000,'active',$6)`,
        [
          fixture.customerA,
          fixture.customerB,
          ownerA.storeId,
          ownerB.storeId,
          randomUUID(),
          randomUUID(),
        ],
      );
      await database.admin.query(
        `insert into ledger.suppliers(id,store_id,name,normalized_name,status,operation_id)
         values
           ($1,$3,'S22.5 Supplier A','s22.5 supplier a','active',$5),
           ($2,$4,'S22.5 Supplier B','s22.5 supplier b','active',$6)`,
        [
          fixture.supplierA,
          fixture.supplierB,
          ownerA.storeId,
          ownerB.storeId,
          randomUUID(),
          randomUUID(),
        ],
      );
      await database.admin.query(
        `insert into ledger.products(
           id,store_id,name,normalized_name,measurement_type,track_inventory,status,operation_id
         ) values
           ($1,$3,'S22.5 Product A','s22.5 product a','count',true,'active',$5),
           ($2,$4,'S22.5 Product B','s22.5 product b','count',true,'active',$6)`,
        [
          fixture.productA,
          fixture.productB,
          ownerA.storeId,
          ownerB.storeId,
          randomUUID(),
          randomUUID(),
        ],
      );
      await database.admin.query(
        `insert into ledger.product_units(
           id,store_id,product_id,measurement_type,unit_name,is_base,
           factor_num,factor_den,status,operation_id
         ) values
           ($1,$3,$5,'count','piece',true,1,1,'active',$7),
           ($2,$4,$6,'count','piece',true,1,1,'active',$8)`,
        [
          fixture.unitA,
          fixture.unitB,
          ownerA.storeId,
          ownerB.storeId,
          fixture.productA,
          fixture.productB,
          randomUUID(),
          randomUUID(),
        ],
      );
      await database.admin.query(
        `insert into ledger.money_accounts(
           id,store_id,name,normalized_name,account_type,availability,is_default,status,operation_id
         ) values
           ($1,$3,'S22.5 Cash','s22.5 cash','cash','available',true,'active',$5),
           ($2,$3,'S22.5 Bank','s22.5 bank','transfer','available',false,'active',$6),
           ($4,$7,'S22.5 Store B Cash','s22.5 store b cash','cash','available',true,'active',$8)`,
        [
          fixture.cashAccount,
          fixture.bankAccount,
          ownerA.storeId,
          fixture.cashAccountB,
          randomUUID(),
          randomUUID(),
          ownerB.storeId,
          randomUUID(),
        ],
      );
      await database.admin.query(
        `insert into ledger.expense_categories(
           id,store_id,name,normalized_name,status,operation_id
         ) values($1,$2,'S22.5 Expenses','s22.5 expenses','active',$3)`,
        [fixture.expenseCategory, ownerA.storeId, randomUUID()],
      );

      sourceApp = await createHarness({
        databaseName: database.databaseName,
        attachmentStorage: sourceAttachmentStorage,
        bootstrapRoot: sourceBootstrapRoot,
      });
      await login(sourceApp.server, ownerA, password);
      await login(sourceApp.server, ownerB, password);

      const ownerContribution = {
        operationId: randomUUID(),
        moneyAccountId: fixture.cashAccount,
        amountMinor: '10000',
        occurredAt,
      };
      await request(sourceApp.server)
        .post('/v1/owner-ledger/contributions')
        .set(authorization(ownerA))
        .send(ownerContribution)
        .expect(201);
      await request(sourceApp.server)
        .post('/v1/inventory/increase')
        .set(authorization(ownerA))
        .send({
          operationId: randomUUID(),
          productId: fixture.productA,
          productUnitId: fixture.unitA,
          selectedQuantityMilli: '10000',
          totalPurchaseCostMinor: '2000',
          occurredAt,
        })
        .expect(201);

      const trackedSale = body(
        await request(sourceApp.server)
          .post('/v1/sales')
          .set(authorization(ownerA))
          .send({
            operationId: randomUUID(),
            customerId: fixture.customerA,
            occurredAt,
            items: [
              {
                isManualLine: false,
                productId: fixture.productA,
                productUnitId: fixture.unitA,
                quantityMilli: '2000',
                unitPriceMinor: '500',
                lineTotalMinor: '1000',
              },
            ],
            payments: [{ moneyAccountId: fixture.cashAccount, amountMinor: '400' }],
            totalMinor: '1000',
          })
          .expect(201),
      ) as unknown as SalePostingResponse;
      const trackedItem = trackedSale.items[0];
      if (!trackedItem) throw new Error('Tracked Sale fixture is missing its line.');
      await request(sourceApp.server)
        .post(`/v1/sales/${trackedSale.sale.id}/return`)
        .set(authorization(ownerA))
        .send({
          operationId: randomUUID(),
          occurredAt,
          reason: 'Pre-recovery-point representative Return',
          lines: [
            {
              saleItemId: trackedItem.id,
              quantityMilli: '1000',
              disposition: 'DAMAGED_NO_RESTOCK',
            },
          ],
        })
        .expect(201);
      await request(sourceApp.server)
        .post(`/v1/customers/${fixture.customerA}/payments`)
        .set(authorization(ownerA))
        .send({
          operationId: randomUUID(),
          occurredAt,
          allocationMode: 'fifo',
          tenders: [{ moneyAccountId: fixture.cashAccount, amountMinor: '100' }],
        })
        .expect(201);
      await request(sourceApp.server)
        .post('/v1/sales')
        .set(authorization(ownerA))
        .send({
          operationId: randomUUID(),
          customerId: fixture.customerA,
          occurredAt,
          items: [
            {
              isManualLine: true,
              description: 'Pre-point Receivable',
              unitName: 'service',
              quantityMilli: '1000',
              unitPriceMinor: '700',
              lineTotalMinor: '700',
            },
          ],
          payments: [],
          totalMinor: '700',
        })
        .expect(201);

      const invoice = body(
        await request(sourceApp.server)
          .post(`/v1/suppliers/${fixture.supplierA}/invoices`)
          .set(authorization(ownerA))
          .send({
            operationId: randomUUID(),
            invoiceNumber: 'S225-PRE-1',
            occurredAt,
            dueAt: occurredAt,
            items: [
              {
                description: 'Payable-only recovery fixture',
                unitName: 'piece',
                quantityMilli: '1000',
                unitCostMinor: '1000',
                lineTotalMinor: '1000',
              },
            ],
            totalMinor: '1000',
          })
          .expect(201),
      );
      const invoiceId = nestedId(invoice, 'invoice');
      await request(sourceApp.server)
        .post(`/v1/suppliers/${fixture.supplierA}/payments`)
        .set(authorization(ownerA))
        .send({
          operationId: randomUUID(),
          paymentSource: 'money_account',
          moneyAccountId: fixture.cashAccount,
          amountMinor: '300',
          occurredAt,
          allocations: [
            { targetType: 'purchase_invoice', targetId: invoiceId, amountMinor: '300' },
          ],
        })
        .expect(201);

      await request(sourceApp.server)
        .post('/v1/expenses')
        .set(authorization(ownerA))
        .send({
          id: fixture.preExpense,
          operationId: randomUUID(),
          categoryId: fixture.expenseCategory,
          description: 'Pre-point due Expense',
          amountMinor: '600',
          occurredAt,
          dueAt: occurredAt,
          mode: 'DUE',
        })
        .expect(201);
      await request(sourceApp.server)
        .post(`/v1/expenses/${fixture.preExpense}/payments`)
        .set(authorization(ownerA))
        .send({
          operationId: randomUUID(),
          paymentSource: 'money_account',
          moneyAccountId: fixture.cashAccount,
          amountMinor: '200',
          occurredAt,
        })
        .expect(201);
      await request(sourceApp.server)
        .post('/v1/money-transfers')
        .set(authorization(ownerA))
        .send({
          operationId: randomUUID(),
          sourceAccountId: fixture.cashAccount,
          destinationAccountId: fixture.bankAccount,
          amountMinor: '100',
          occurredAt,
        })
        .expect(201);

      const activeAttachmentBody = Buffer.from('%PDF-1.7\nS22.5 active receipt\n%%EOF');
      const activeAttachment = body(
        await request(sourceApp.server)
          .post('/v1/attachments')
          .set(authorization(ownerA))
          .field('entityType', 'expense')
          .field('entityId', fixture.preExpense)
          .attach('file', activeAttachmentBody, {
            filename: 'active-receipt.pdf',
            contentType: 'application/pdf',
          })
          .expect(201),
      );
      const activeAttachmentId = stringField(activeAttachment, 'id');
      const removedAttachmentBody = Buffer.from('%PDF-1.7\nS22.5 removed evidence\n%%EOF');
      const removedAttachment = body(
        await request(sourceApp.server)
          .post('/v1/attachments')
          .set(authorization(ownerA))
          .field('entityType', 'customer')
          .field('entityId', fixture.customerA)
          .attach('file', removedAttachmentBody, {
            filename: 'removed-evidence.pdf',
            contentType: 'application/pdf',
          })
          .expect(201),
      );
      const removedAttachmentId = stringField(removedAttachment, 'id');
      await request(sourceApp.server)
        .delete(`/v1/attachments/${removedAttachmentId}`)
        .set(authorization(ownerA))
        .expect(200);
      const removedObject = await database.admin.query<{ remoteKey: string }>(
        `select remote_key as "remoteKey" from ledger.attachments where id=$1`,
        [removedAttachmentId],
      );
      const removedRemoteKey = removedObject.rows[0]?.remoteKey;
      if (!removedRemoteKey) throw new Error('Removed attachment object key is unavailable.');
      sourceAttachmentStorage.set(removedRemoteKey, removedAttachmentBody);

      const oldLicense = body(
        await request(sourceApp.server)
          .post('/v1/licenses/verify')
          .set(authorization(ownerA))
          .send({ operationId: randomUUID() })
          .expect(200),
      ) as unknown as OfflineLicenseResponse;
      const oldSyncAuthentication = body(
        await request(sourceApp.server)
          .post('/v1/sync/auth/token')
          .send({ refreshToken: ownerA.refreshToken })
          .expect(200),
      ) as unknown as SyncAuthenticationResponse;
      const oldBootstrap = body(
        await request(sourceApp.server)
          .post('/v1/sync/bootstrap')
          .set(authorization(ownerA))
          .send({ bootstrapVersion: 1, licenseId: oldLicense.license.payload.licenseId })
          .expect(200),
      ) as unknown as BootstrapManifest;

      await database.admin.query(
        `update platform.subscriptions
         set expires_at=clock_timestamp()+interval '5 seconds'
         where store_id=$1 and status='active'`,
        [ownerB.storeId],
      );
      const prePointSnapshot = await accountingSnapshot(database.admin, ownerA.storeId);
      await assertAccountingViews(database.admin, ownerA.storeId);
      const initialControl = await readRecoveryControl(
        connectionFor(environment.migrationUrl, database.databaseName),
      );
      const recoveryConfig: RecoveryRuntimeConfig = {
        applicationEnvironment: 'test',
        environmentId: 'integration-test',
        sourceRevision: null,
        storage: { driver: 'filesystem', rootDirectory: recoveryRoot },
        logicalMaximumAgeHours: 36,
        attachmentBatchSize: 100,
        attachmentConcurrency: 2,
        attachmentOrphanGraceHours: 168,
      };
      const toolchain = await resolvePostgresToolchain(process.env.RECOVERY_POSTGRES_BIN_DIR);
      const sourceAdminUrl = connectionFor(environment.adminUrl, database.databaseName);
      const sourceMigrationUrl = connectionFor(environment.migrationUrl, database.databaseName);
      const sourceRuntimeUrl = connectionFor(environment.runtimeUrl, database.databaseName);
      const recoveryPoint = await createVerifiedRecoveryPoint({
        connectionString: sourceAdminUrl,
        config: recoveryConfig,
        storage: recoveryStorage,
        toolchain,
      });
      recoveryPointCreatedAt = recoveryPoint.createdAt;
      const attachmentManifest = await protectAttachmentRecoveryPoint({
        recoveryPointId: recoveryPoint.recoveryPointId,
        config: recoveryConfig,
        recoveryStorage,
        sourceStorage: sourceAttachmentStorage,
      });
      expect(recoveryPoint).toMatchObject({
        state: 'VERIFIED',
        migrations: { appliedCount: 33, checksumStatus: 'PASS' },
        verification: { status: 'VERIFIED', structuralCheck: 'PASS' },
      });
      expect(attachmentManifest).toMatchObject({
        verificationStatus: 'VERIFIED',
        attachmentEntryCount: 1,
      });

      const postPointOperationIds = {
        sale: randomUUID(),
        collection: randomUUID(),
        supplierPayment: randomUUID(),
        expense: randomUUID(),
        inventory: randomUUID(),
        saleReturn: randomUUID(),
      };
      const postPointSale = body(
        await request(sourceApp.server)
          .post('/v1/sales')
          .set(authorization(ownerA))
          .send({
            operationId: postPointOperationIds.sale,
            customerId: fixture.customerA,
            occurredAt,
            items: [
              {
                isManualLine: true,
                description: 'Post-point Sale A',
                unitName: 'service',
                quantityMilli: '1000',
                unitPriceMinor: '500',
                lineTotalMinor: '500',
              },
            ],
            payments: [],
            totalMinor: '500',
          })
          .expect(201),
      ) as unknown as SalePostingResponse;
      await request(sourceApp.server)
        .post(`/v1/customers/${fixture.customerA}/payments`)
        .set(authorization(ownerA))
        .send({
          operationId: postPointOperationIds.collection,
          occurredAt,
          allocationMode: 'fifo',
          tenders: [{ moneyAccountId: fixture.cashAccount, amountMinor: '200' }],
        })
        .expect(201);
      await request(sourceApp.server)
        .post(`/v1/suppliers/${fixture.supplierA}/payments`)
        .set(authorization(ownerA))
        .send({
          operationId: postPointOperationIds.supplierPayment,
          paymentSource: 'money_account',
          moneyAccountId: fixture.cashAccount,
          amountMinor: '200',
          occurredAt,
          allocations: [
            { targetType: 'purchase_invoice', targetId: invoiceId, amountMinor: '200' },
          ],
        })
        .expect(201);
      await request(sourceApp.server)
        .post('/v1/expenses')
        .set(authorization(ownerA))
        .send({
          id: fixture.postExpense,
          operationId: postPointOperationIds.expense,
          categoryId: fixture.expenseCategory,
          description: 'Post-point paid Expense D',
          amountMinor: '250',
          occurredAt,
          mode: 'MONEY_PAID',
          moneyAccountId: fixture.cashAccount,
        })
        .expect(201);
      await request(sourceApp.server)
        .post('/v1/inventory/increase')
        .set(authorization(ownerA))
        .send({
          operationId: postPointOperationIds.inventory,
          productId: fixture.productA,
          productUnitId: fixture.unitA,
          selectedQuantityMilli: '1000',
          totalPurchaseCostMinor: '200',
          occurredAt,
        })
        .expect(201);
      const postPointSaleItem = postPointSale.items[0];
      if (!postPointSaleItem) throw new Error('Post-point Sale line is unavailable.');
      await request(sourceApp.server)
        .post(`/v1/sales/${postPointSale.sale.id}/return`)
        .set(authorization(ownerA))
        .send({
          operationId: postPointOperationIds.saleReturn,
          occurredAt,
          reason: 'Post-point Return F',
          lines: [
            {
              saleItemId: postPointSaleItem.id,
              quantityMilli: '100',
              disposition: 'DAMAGED_NO_RESTOCK',
            },
          ],
        })
        .expect(201);

      let localSequence = 1n;
      const offlineCustomerIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const offlineOperationIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const oldEnvelope = (index: number, dependencies: string[] = []): Record<string, unknown> => {
        const signed = oldLicense.license;
        return {
          protocolVersion: 1,
          operationId: offlineOperationIds[index],
          operationType: 'customers.create.v1',
          storeId: ownerA.storeId,
          deviceId: ownerA.deviceId,
          recoveryGenerationId: oldSyncAuthentication.recoveryGenerationId,
          aggregateId: offlineCustomerIds[index],
          clientRecordedAt: signed.payload.issuedAt,
          payload: {
            name: `S22.5 Offline ${index.toString()}`,
            phone: `05990023${index.toString()}0`,
          },
          offlineLicenseId: signed.payload.licenseId,
          signedLicense: signed,
          signingKeyId: signed.payload.signingKeyId,
          subscriptionId: signed.payload.subscriptionId,
          subscriptionVersion: signed.payload.subscriptionVersion,
          trustedTimeEvidence: {
            version: 1,
            trustedServerTime: signed.payload.issuedAt,
            observedDeviceTime: signed.payload.issuedAt,
            clockState: 'trusted',
            knownStoreStatus: 'active',
            knownStoreStatusAt: signed.payload.issuedAt,
          },
          localSequence: (localSequence++).toString(),
          dependsOnOperationIds: dependencies,
        };
      };
      const acknowledgedEnvelope = oldEnvelope(0);
      const ackLostEnvelope = oldEnvelope(1);
      const localOnlyEnvelope = oldEnvelope(2);
      const dependentEnvelope = oldEnvelope(3, [offlineOperationIds[2] ?? '']);
      const acknowledgedPush = await request(sourceApp.server)
        .post('/v1/sync/push')
        .set('authorization', `Bearer ${oldSyncAuthentication.syncToken}`)
        .send({ operations: [acknowledgedEnvelope] })
        .expect(200);
      expect(body(acknowledgedPush).results).toEqual([
        expect.objectContaining({ status: 'APPLIED' }),
      ]);
      await request(sourceApp.server)
        .post('/v1/sync/push')
        .set('authorization', `Bearer ${oldSyncAuthentication.syncToken}`)
        .send({ operations: [ackLostEnvelope] })
        .expect(200);

      const postPointDeviceId = randomUUID();
      await request(sourceApp.server)
        .post('/v1/auth/login')
        .send({
          email: ownerA.email,
          password,
          storeId: ownerA.storeId,
          deviceId: postPointDeviceId,
          deviceName: 'S22.5 post-point device',
          devicePlatform: 'android',
        })
        .expect(200);

      const inFlightCustomerId = randomUUID();
      const inFlight = await database.runtime.connect();
      let inFlightReleased = false;
      const execution = new RecoveryExecutionService({
        storage: recoveryStorage,
        targetAttachmentStorage,
        toolchain,
        adminConnectionString: sourceAdminUrl,
        migrationConnectionString: sourceMigrationUrl,
        runtimeConnectionString: sourceRuntimeUrl,
        applicationEnvironment: 'test',
        environmentId: 'integration-test',
      });
      try {
        await inFlight.query('begin');
        await inFlight.query(
          `select set_config('app.store_id',$1,true), set_config('app.user_id',$2,true),
                  set_config('app.device_id',$3,true), set_config('app.request_id',$4,true)`,
          [ownerA.storeId, ownerA.userId, ownerA.deviceId, randomUUID()],
        );
        await inFlight.query(`select * from ledger.assert_platform_write_authority_v1($1::uuid)`, [
          initialControl.recoveryGenerationId,
        ]);
        await inFlight.query(
          `insert into ledger.customers(
             id,store_id,name,normalized_name,phone,normalized_phone,status,device_id,operation_id
           ) values(
             $1,$2,'S22.5 in-flight','s22.5 in-flight','0599002299','+970599002299',
             'active',$3,$4
           )`,
          [inFlightCustomerId, ownerA.storeId, ownerA.deviceId, randomUUID()],
        );
        const prepared = await execution.prepare(recoveryPoint.recoveryPointId);
        targetDatabaseName = prepared.targetDatabaseName;
        expect(prepared.phase).toBe('PREPARED');
        await expect(execution.prepare(recoveryPoint.recoveryPointId)).rejects.toThrow(
          'already active',
        );
        await expect(
          execution.activate(prepared.recoveryAttemptId, recoveryPoint.recoveryPointId),
        ).rejects.toThrow('not bound');

        disasterAt = new Date().toISOString();
        recoveryStartedAt = disasterAt;
        let restoreResolved = false;
        const restoreDatabase = execution
          .restoreDatabase(prepared.recoveryAttemptId)
          .then((value) => {
            restoreResolved = true;
            return value;
          });
        await delay(150);
        expect(restoreResolved).toBe(false);
        await inFlight.query('commit');
        inFlight.release();
        inFlightReleased = true;
        await restoreDatabase;
        databaseRestoredAt = new Date().toISOString();

        const fencedWrite = await request(sourceApp.server)
          .post('/v1/owner-ledger/contributions')
          .set(authorization(ownerA))
          .send({ ...ownerContribution, operationId: randomUUID(), amountMinor: '1' });
        expect(fencedWrite.status).toBeGreaterThanOrEqual(400);
        const fencedLicense = await request(sourceApp.server)
          .post('/v1/licenses/verify')
          .set(authorization(ownerA))
          .send({ operationId: randomUUID() });
        expect(fencedLicense.status).toBeGreaterThanOrEqual(400);
        const fencedPush = await request(sourceApp.server)
          .post('/v1/sync/push')
          .set('authorization', `Bearer ${oldSyncAuthentication.syncToken}`)
          .send({ operations: [localOnlyEnvelope] });
        expect(fencedPush.status).toBeGreaterThanOrEqual(400);
        const fencedPull = await request(sourceApp.server)
          .get(`/v1/sync/pull?cursor=${encodeURIComponent(oldBootstrap.baseCursor)}`)
          .set(authorization(ownerA));
        expect(fencedPull.status).toBeGreaterThanOrEqual(400);

        await closeHarness(sourceApp);
        sourceApp = undefined;
        await expect(execution.verify(prepared.recoveryAttemptId)).rejects.toThrow(
          'not ready for verification',
        );
        const entriesDirectory = await mkdtemp(join(tmpdir(), 'dokana-s225-entries-'));
        const entriesPath = join(entriesDirectory, 'entries.ndjson');
        try {
          await recoveryStorage.downloadToFile(
            attachmentManifest.entries.key,
            entriesPath,
            1024 * 1024,
          );
          const entries = [];
          for await (const entry of readAttachmentRecoveryEntries(
            entriesPath,
            recoveryPoint.recoveryPointId,
          )) {
            entries.push(entry);
          }
          expect(entries).toHaveLength(1);
          const activeEntry = entries[0];
          if (!activeEntry) throw new Error('Active attachment recovery entry is unavailable.');
          const protectedBody = await recoveryStorage.readBuffer(
            activeEntry.protectedObjectKey,
            ATTACHMENT_MAX_BYTES,
          );
          if (!protectedBody) throw new Error('Protected attachment body is unavailable.');

          await recoveryStorage.deleteObject(activeEntry.protectedObjectKey);
          await expect(execution.restoreAttachments(prepared.recoveryAttemptId)).rejects.toThrow(
            'integrity verification',
          );
          await expect(
            execution.activate(prepared.recoveryAttemptId, recoveryPoint.recoveryPointId),
          ).rejects.toThrow('not bound');
          await recoveryStorage.putBuffer({
            key: activeEntry.protectedObjectKey,
            body: protectedBody,
            contentType: activeEntry.mediaType,
            contentLength: protectedBody.byteLength,
            checksumSha256: activeEntry.sha256,
          });

          const corruptProtectedBody = Buffer.from(protectedBody);
          corruptProtectedBody[0] = (corruptProtectedBody[0] ?? 0) ^ 0xff;
          await recoveryStorage.deleteObject(activeEntry.protectedObjectKey);
          await recoveryStorage.putBuffer({
            key: activeEntry.protectedObjectKey,
            body: corruptProtectedBody,
            contentType: activeEntry.mediaType,
            contentLength: corruptProtectedBody.byteLength,
            checksumSha256: activeEntry.sha256,
          });
          await expect(execution.restoreAttachments(prepared.recoveryAttemptId)).rejects.toThrow(
            'integrity verification',
          );
          await recoveryStorage.deleteObject(activeEntry.protectedObjectKey);
          await recoveryStorage.putBuffer({
            key: activeEntry.protectedObjectKey,
            body: protectedBody,
            contentType: activeEntry.mediaType,
            contentLength: protectedBody.byteLength,
            checksumSha256: activeEntry.sha256,
          });

          await execution.restoreAttachments(prepared.recoveryAttemptId);
          attachmentsRestoredAt = new Date().toISOString();
          const operationalKey = `stores/${ownerA.storeId}/attachments/${activeAttachmentId}`;
          const operationalObject = await targetAttachmentStorage.getObject(operationalKey);
          expect(operationalObject).toEqual({
            body: activeAttachmentBody,
            contentLength: activeAttachmentBody.byteLength,
          });
          await targetAttachmentStorage.deleteObject(operationalKey);
          await expect(execution.verify(prepared.recoveryAttemptId)).rejects.toThrow(
            'integrity verification',
          );
          await expect(
            execution.approve(prepared.recoveryAttemptId, recoveryPoint.recoveryPointId),
          ).rejects.toThrow('not bound');
          await execution.restoreAttachments(prepared.recoveryAttemptId);

          targetAttachmentStorage.corruptExistingObject(operationalKey);
          await expect(execution.verify(prepared.recoveryAttemptId)).rejects.toThrow(
            'integrity verification',
          );
          await targetAttachmentStorage.deleteObject(operationalKey);
          await execution.restoreAttachments(prepared.recoveryAttemptId);

          const targetAdminUrl = withDatabase(environment.adminUrl, prepared.targetDatabaseName);
          const targetMigrationUrl = withDatabase(
            environment.migrationUrl,
            prepared.targetDatabaseName,
          );
          const targetRuntimeUrl = withDatabase(
            environment.runtimeUrl,
            prepared.targetDatabaseName,
          );
          const targetAdmin = createTestPool(targetAdminUrl, 'dokana-s225-target-admin', 2);
          try {
            await targetAdmin.query(`alter table ledger.customers no force row level security`);
            await expect(execution.verify(prepared.recoveryAttemptId)).rejects.toThrow(
              'security objects are incomplete',
            );
            await expect(
              execution.approve(prepared.recoveryAttemptId, recoveryPoint.recoveryPointId),
            ).rejects.toThrow('not bound');
            await targetAdmin.query(`alter table ledger.customers force row level security`);

            await expect(execution.verify(prepared.recoveryAttemptId)).resolves.toMatchObject({
              phase: 'VERIFIED',
            });
            verifiedAt = new Date().toISOString();
            const restoredSnapshot = await accountingSnapshot(targetAdmin, ownerA.storeId);
            expect(restoredSnapshot).toEqual(prePointSnapshot);
            await assertAccountingViews(targetAdmin, ownerA.storeId);
            const postPointResidue = await targetAdmin.query<{ count: number }>(
              `select (
                 (select count(*) from sync.processed_operations
                  where operation_id=any($1::uuid[]))
                 + (select count(*) from ledger.expenses where id=$2)
                 + (select count(*) from ledger.devices where id=$3)
                 + (select count(*) from ledger.customers where id=$4)
               )::integer as count`,
              [
                Object.values(postPointOperationIds),
                fixture.postExpense,
                postPointDeviceId,
                inFlightCustomerId,
              ],
            );
            expect(postPointResidue.rows[0]?.count).toBe(0);

            const restoredAttachments = await targetAdmin.query<{
              id: string;
              remoteKey: string;
              removed: boolean;
            }>(
              `select id,remote_key as "remoteKey",removed_at is not null as removed
               from ledger.attachments where id=any($1::uuid[]) order by id`,
              [[activeAttachmentId, removedAttachmentId]],
            );
            expect(restoredAttachments.rows).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ id: activeAttachmentId, removed: false }),
                expect.objectContaining({ id: removedAttachmentId, removed: true }),
              ]),
            );
            const activeRow = restoredAttachments.rows.find((row) => row.id === activeAttachmentId);
            const removedRow = restoredAttachments.rows.find(
              (row) => row.id === removedAttachmentId,
            );
            if (!activeRow || !removedRow) {
              throw new Error('Restored attachment metadata is incomplete.');
            }
            expect(activeRow.remoteKey).toBe(
              `stores/${ownerA.storeId}/attachments/${activeAttachmentId}`,
            );
            await expect(targetAttachmentStorage.getObject(activeRow.remoteKey)).resolves.toEqual({
              body: activeAttachmentBody,
              contentLength: activeAttachmentBody.byteLength,
            });
            await expect(
              targetAttachmentStorage.getObject(removedRow.remoteKey),
            ).resolves.toBeNull();

            const targetRuntime = createTestPool(targetRuntimeUrl, 'dokana-s225-target-rls', 1);
            try {
              const tenant = await targetRuntime.connect();
              try {
                await tenant.query('begin');
                await tenant.query(
                  `select set_config('app.store_id',$1,true), set_config('app.user_id',$2,true),
                          set_config('app.device_id',$3,true), set_config('app.request_id',$4,true)`,
                  [ownerA.storeId, ownerA.userId, ownerA.deviceId, randomUUID()],
                );
                for (const table of [
                  'customers',
                  'suppliers',
                  'products',
                  'sales',
                  'customer_ledger_entries',
                  'customer_payments',
                  'supplier_ledger_entries',
                  'supplier_payments',
                  'money_movements',
                  'inventory_movements',
                  'notifications',
                  'attachments',
                ]) {
                  const isolated = await tenant.query<{ count: number }>(
                    `select count(*)::integer as count from ledger.${table} where store_id=$1`,
                    [ownerB.storeId],
                  );
                  expect(isolated.rows[0]?.count).toBe(0);
                }
                await expect(
                  tenant.query(`select * from audit.central_audit_logs where store_id=$1`, [
                    ownerB.storeId,
                  ]),
                ).rejects.toMatchObject({ code: '42501' });
                await tenant.query('rollback');
              } finally {
                await tenant.query('rollback').catch(() => undefined);
                tenant.release();
              }
            } finally {
              await targetRuntime.end();
            }

            await execution.approve(prepared.recoveryAttemptId, recoveryPoint.recoveryPointId);
            const activated = await execution.activate(
              prepared.recoveryAttemptId,
              recoveryPoint.recoveryPointId,
            );
            activatedAt = new Date().toISOString();
            expect(activated.recoveryGenerationId).not.toBe(initialControl.recoveryGenerationId);
            const targetControl = await readRecoveryControl(targetMigrationUrl);
            expect(targetControl).toMatchObject({
              serviceState: 'ACTIVE',
              recoveryGenerationId: activated.recoveryGenerationId,
            });
            expect(targetControl.authorityNotBefore).not.toBeNull();
            expect(await readRecoveryControl(sourceMigrationUrl)).toMatchObject({
              serviceState: 'FENCED',
              recoveryGenerationId: initialControl.recoveryGenerationId,
            });
            const targetMigrations = await readVerifiedMigrationState(targetAdminUrl);
            expect(targetMigrations).toMatchObject({
              appliedCount: 33,
              latestFilename: migrationFilename,
            });
          } finally {
            await targetAdmin.end();
          }
        } finally {
          await rm(entriesDirectory, { recursive: true, force: true });
        }

        targetApp = await createHarness({
          databaseName: prepared.targetDatabaseName,
          attachmentStorage: targetAttachmentStorage,
          bootstrapRoot: targetBootstrapRoot,
        });
        await request(targetApp.server)
          .get(`/v1/customers/${fixture.customerA}`)
          .set(authorization(ownerA))
          .expect(401);
        await request(targetApp.server)
          .post('/v1/sync/auth/token')
          .send({ refreshToken: ownerA.refreshToken })
          .expect(401);

        await login(targetApp.server, ownerA, password);
        const expiredSubscription = await database.admin.query<{ expiresAt: Date }>(
          `select expires_at as "expiresAt" from platform.subscriptions
           where store_id=$1 order by created_at desc limit 1`,
          [ownerB.storeId],
        );
        const storeBExpiresAt = expiredSubscription.rows[0]?.expiresAt;
        if (!storeBExpiresAt) throw new Error('Store B Subscription is unavailable.');
        const waitMilliseconds = storeBExpiresAt.getTime() - Date.now() + 100;
        if (waitMilliseconds > 0) await delay(waitMilliseconds);
        const expiredLogin = await request(targetApp.server).post('/v1/auth/login').send({
          email: ownerB.email,
          password,
          storeId: ownerB.storeId,
          deviceId: ownerB.deviceId,
          deviceName: 'S22.5 expired entitlement check',
          devicePlatform: 'android',
        });
        expect(expiredLogin.status).toBe(200);
        const expiredAuthentication = body(expiredLogin) as unknown as AuthenticationResponse;
        ownerB.accessToken = expiredAuthentication.accessToken;
        ownerB.refreshToken = expiredAuthentication.refreshToken;
        const expiredWrite = await request(targetApp.server)
          .post('/v1/owner-ledger/contributions')
          .set(authorization(ownerB))
          .send({
            operationId: randomUUID(),
            moneyAccountId: fixture.cashAccountB,
            amountMinor: '1',
            occurredAt,
          });
        expect(expiredWrite.status).toBe(403);
        const expiredLicense = await request(targetApp.server)
          .post('/v1/licenses/verify')
          .set(authorization(ownerB))
          .send({ operationId: randomUUID() });
        expect(expiredLicense.status).toBeGreaterThanOrEqual(400);

        await request(targetApp.server)
          .get(`/v1/customers/${fixture.customerB}`)
          .set(authorization(ownerA))
          .expect(404);
        await request(targetApp.server)
          .get(`/v1/suppliers/${fixture.supplierB}`)
          .set(authorization(ownerA))
          .expect(404);
        await request(targetApp.server)
          .get(`/v1/products/${fixture.productB}`)
          .set(authorization(ownerA))
          .expect(404);
        await request(targetApp.server)
          .get(`/v1/attachments/${activeAttachmentId}/content`)
          .set(authorization(ownerA))
          .expect(200)
          .expect(activeAttachmentBody);
        await request(targetApp.server)
          .get(`/v1/attachments/${removedAttachmentId}/content`)
          .set(authorization(ownerA))
          .expect(404);

        const freshLicense = body(
          await request(targetApp.server)
            .post('/v1/licenses/verify')
            .set(authorization(ownerA))
            .send({ operationId: randomUUID() })
            .expect(200),
        ) as unknown as OfflineLicenseResponse;
        const freshSyncAuthentication = body(
          await request(targetApp.server)
            .post('/v1/sync/auth/token')
            .send({ refreshToken: ownerA.refreshToken })
            .expect(200),
        ) as unknown as SyncAuthenticationResponse;
        await request(targetApp.server)
          .get(`/v1/sync/pull?cursor=${encodeURIComponent(oldBootstrap.baseCursor)}`)
          .set(authorization(ownerA))
          .expect(410);
        const stalePush = await request(targetApp.server)
          .post('/v1/sync/push')
          .set('authorization', `Bearer ${freshSyncAuthentication.syncToken}`)
          .send({
            operations: [
              acknowledgedEnvelope,
              ackLostEnvelope,
              localOnlyEnvelope,
              dependentEnvelope,
            ],
          })
          .expect(410);
        expect(body(stalePush)).toMatchObject({ code: 'SYNC_REBOOTSTRAP_REQUIRED' });
        const targetAdmin = createTestPool(
          connectionFor(environment.adminUrl, prepared.targetDatabaseName),
          'dokana-s225-post-activation-admin',
          1,
        );
        try {
          const staleEffects = await targetAdmin.query<{ count: number }>(
            `select (
               (select count(*) from ledger.customers where id=any($1::uuid[]))
               + (select count(*) from sync.processed_operations
                  where operation_id=any($2::uuid[]))
               + (select count(*) from sync.offline_operation_provenance_v1
                  where operation_id=any($2::uuid[]))
             )::integer as count`,
            [offlineCustomerIds, offlineOperationIds],
          );
          expect(staleEffects.rows[0]?.count).toBe(0);

          const restoredLicense = await targetAdmin.query<{
            expiresAt: Date;
            issuedAt: Date;
          }>(
            `select expires_at as "expiresAt",issued_at as "issuedAt"
             from platform.license_issuances where id=$1`,
            [oldLicense.license.payload.licenseId],
          );
          expect(restoredLicense.rows[0]?.expiresAt.getTime()).toBe(
            new Date(oldLicense.license.payload.offlineValidUntil).getTime(),
          );
          expect(restoredLicense.rows[0]?.issuedAt.getTime()).toBe(
            new Date(oldLicense.license.payload.issuedAt).getTime(),
          );
          const serverClock = await targetAdmin.query<{ now: Date }>(
            `select clock_timestamp() as now`,
          );
          expect(Math.abs(Date.now() - (serverClock.rows[0]?.now.getTime() ?? 0))).toBeLessThan(
            60_000,
          );
        } finally {
          await targetAdmin.end();
        }

        const freshBootstrap = body(
          await request(targetApp.server)
            .post('/v1/sync/bootstrap')
            .set(authorization(ownerA))
            .send({ bootstrapVersion: 1, licenseId: freshLicense.license.payload.licenseId })
            .expect(200),
        ) as unknown as BootstrapManifest;
        bootstrapCompletedAt = new Date().toISOString();
        expect(freshBootstrap.recoveryGenerationId).toBe(
          freshSyncAuthentication.recoveryGenerationId,
        );
        expect(freshBootstrap.recoveryGenerationId).not.toBe(oldBootstrap.recoveryGenerationId);
        await request(targetApp.server)
          .get(`/v1/sync/pull?cursor=${encodeURIComponent(freshBootstrap.baseCursor)}&limit=10`)
          .set(authorization(ownerA))
          .expect(200);
        const aheadCursor = targetApp.app
          .get(SyncCursorService)
          .issue(ownerA.storeId, freshBootstrap.recoveryGenerationId, 9_223_372_036_854_775_807n);
        await request(targetApp.server)
          .get(`/v1/sync/pull?cursor=${encodeURIComponent(aheadCursor)}&limit=10`)
          .set(authorization(ownerA))
          .expect(400);

        const newSaleOperationId = randomUUID();
        const newSaleBody = {
          operationId: newSaleOperationId,
          occurredAt,
          items: [
            {
              isManualLine: true,
              description: 'Post-recovery authoritative Sale',
              unitName: 'service',
              quantityMilli: '1000',
              unitPriceMinor: '100',
              lineTotalMinor: '100',
            },
          ],
          payments: [{ moneyAccountId: fixture.cashAccount, amountMinor: '100' }],
          totalMinor: '100',
        };
        const newSale = await request(targetApp.server)
          .post('/v1/sales')
          .set(authorization(ownerA))
          .send(newSaleBody)
          .expect(201);
        firstBusinessOperationAt = new Date().toISOString();
        const exactReplay = await request(targetApp.server)
          .post('/v1/sales')
          .set(authorization(ownerA))
          .send(newSaleBody)
          .expect(201);
        expect(exactReplay.body).toEqual(newSale.body);
        await request(targetApp.server)
          .post('/v1/sales')
          .set(authorization(ownerA))
          .send({ ...newSaleBody, notes: 'changed replay must conflict' })
          .expect(409);

        const newFinancialOperationId = randomUUID();
        await request(targetApp.server)
          .post('/v1/owner-ledger/contributions')
          .set(authorization(ownerA))
          .send({
            operationId: newFinancialOperationId,
            moneyAccountId: fixture.cashAccount,
            amountMinor: '50',
            occurredAt,
          })
          .expect(201);
        const newInventoryOperationId = randomUUID();
        await request(targetApp.server)
          .post('/v1/inventory/increase')
          .set(authorization(ownerA))
          .send({
            operationId: newInventoryOperationId,
            productId: fixture.productA,
            productUnitId: fixture.unitA,
            selectedQuantityMilli: '500',
            totalPurchaseCostMinor: '100',
            occurredAt,
          })
          .expect(201);

        const finalAdmin = createTestPool(
          connectionFor(environment.adminUrl, prepared.targetDatabaseName),
          'dokana-s225-final-admin',
          1,
        );
        try {
          const exactlyOnce = await finalAdmin.query<{
            sales: number;
            financial: number;
            inventory: number;
            stalePostPoint: number;
          }>(
            `select
               (select count(*)::integer from ledger.sales where operation_id=$1) as sales,
               (select count(*)::integer from ledger.owner_ledger_entries
                where transaction_group_id=$2) as financial,
               (select count(*)::integer from ledger.manual_inventory_entries
                where operation_id=$3) as inventory,
               (select count(*)::integer from sync.processed_operations
                where operation_id=any($4::uuid[])) as "stalePostPoint"`,
            [
              newSaleOperationId,
              deriveTransactionGroupId(newFinancialOperationId),
              newInventoryOperationId,
              Object.values(postPointOperationIds),
            ],
          );
          expect(exactlyOnce.rows[0]).toEqual({
            sales: 1,
            financial: 1,
            inventory: 1,
            stalePostPoint: 0,
          });
          await assertAccountingViews(finalAdmin, ownerA.storeId);
          const idle = await finalAdmin.query<{ count: number }>(
            `select count(*)::integer as count from pg_stat_activity
             where datname=current_database() and state like 'idle in transaction%'`,
          );
          expect(idle.rows[0]?.count).toBe(0);
        } finally {
          await finalAdmin.end();
        }
      } finally {
        if (!inFlightReleased) {
          await inFlight.query('rollback').catch(() => undefined);
          inFlight.release();
        }
      }

      const finish = new Date();
      const lossWindowMilliseconds =
        disasterAt && recoveryPointCreatedAt
          ? new Date(disasterAt).getTime() - new Date(recoveryPointCreatedAt).getTime()
          : -1;
      process.stdout.write(
        `S22.5_DRILL_EVIDENCE ${JSON.stringify({
          stores: 2,
          migrationCount: 33,
          recoveryPointCreatedAt,
          disasterAt,
          recoveryStartedAt,
          databaseRestoredAt,
          attachmentsRestoredAt,
          verifiedAt,
          activatedAt,
          bootstrapCompletedAt,
          firstBusinessOperationAt,
          observedLossWindowMilliseconds: lossWindowMilliseconds,
          totalDrillMilliseconds: finish.getTime() - drillStartedAt.getTime(),
        })}\n`,
      );
    } finally {
      await closeHarness(targetApp).catch(() => undefined);
      await closeHarness(sourceApp).catch(() => undefined);
      if (targetDatabaseName && /^dokana_recovery_[0-9a-f]{32}$/.test(targetDatabaseName)) {
        const management = createTestPool(
          withDatabase(environment.adminUrl, 'postgres'),
          'dokana-s225-target-cleanup',
          1,
        );
        try {
          await management.query(
            `select pg_terminate_backend(pid) from pg_stat_activity
             where datname=$1 and pid<>pg_backend_pid()`,
            [targetDatabaseName],
          );
          await management.query(`drop database if exists "${targetDatabaseName}"`);
        } finally {
          await management.end();
        }
      }
      await database?.close().catch(() => undefined);
      await Promise.all([
        rm(recoveryRoot, { recursive: true, force: true }),
        rm(sourceBootstrapRoot, { recursive: true, force: true }),
        rm(targetBootstrapRoot, { recursive: true, force: true }),
      ]);
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
});
