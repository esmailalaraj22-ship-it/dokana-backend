import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
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
import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import type { AuthenticationResponse, SyncAuthenticationResponse } from '../src/auth/auth.types';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import { NotificationSchedulerService } from '../src/notifications/notification-scheduler.service';
import { NotificationRepository } from '../src/notifications/notification.repository';
import type { OfflineLicenseResponse } from '../src/offline-licenses/offline-license.types';
import type { OfflineOperationPushResult } from '../src/sync/offline-operation.contract';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
  upgradeInventoryTestDatabaseToCurrent,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeWithPostgres = environment ? describe : describe.skip;

jest.setTimeout(300_000);

interface Identity {
  storeId: string;
  userId: string;
  membershipId: string;
  deviceId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

interface NotificationItem {
  id: string;
  type: string;
  read: boolean;
  lifecycle: 'active' | 'resolved';
  subject: { type: string; id: string } | null;
}

interface AuditItem {
  id: string;
  action: string;
  entity: { type: string; id: string; reference: string | null };
  actor: { type: string; userId: string | null; displayName: string | null };
  context: Record<string, unknown>;
}

class NullLogDestination implements DestinationStream {
  write(): void {
    return;
  }
}

class IntegratedAttachmentStorage implements AttachmentStoragePort {
  readonly objects = new Map<string, { body: Buffer; lastModified: Date }>();

  putObject(input: PutAttachmentObjectInput): Promise<void> {
    this.objects.set(input.key, { body: Buffer.from(input.body), lastModified: new Date() });
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
    return Promise.resolve({
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(input.prefix))
        .slice(0, input.limit)
        .map(([key, object]) => ({ key, lastModified: object.lastModified })),
      nextToken: null,
    });
  }
}

class IntegratedAttachmentScanner implements AttachmentMalwareScannerPort {
  scan(): Promise<AttachmentScanResult> {
    return Promise.resolve('clean');
  }
}

function databaseUrl(source: string, databaseName: string): string {
  const parsed = new URL(source);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function body(response: Response): Record<string, unknown> {
  if (typeof response.body !== 'object' || response.body === null || Array.isArray(response.body)) {
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
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
    throw new Error(`Expected ${field} to be an object.`);
  }
  return stringField(nested as Record<string, unknown>, 'id');
}

describeWithPostgres('S21 integrated Owner operations closure', () => {
  const identities = {
    ownerA: {
      storeId: randomUUID(),
      userId: randomUUID(),
      membershipId: randomUUID(),
      deviceId: randomUUID(),
      email: `s21-closure-owner-a-${randomUUID()}@example.test`,
      accessToken: '',
      refreshToken: '',
    },
    ownerA2: {
      storeId: '',
      userId: randomUUID(),
      membershipId: randomUUID(),
      deviceId: randomUUID(),
      email: `s21-closure-owner-a2-${randomUUID()}@example.test`,
      accessToken: '',
      refreshToken: '',
    },
    ownerB: {
      storeId: randomUUID(),
      userId: randomUUID(),
      membershipId: randomUUID(),
      deviceId: randomUUID(),
      email: `s21-closure-owner-b-${randomUUID()}@example.test`,
      accessToken: '',
      refreshToken: '',
    },
  } satisfies Record<string, Identity>;
  identities.ownerA2.storeId = identities.ownerA.storeId;

  const fixture = {
    customerId: randomUUID(),
    supplierId: randomUUID(),
    productId: randomUUID(),
    productUnitId: randomUUID(),
    moneyAccountId: randomUUID(),
    expenseCategoryId: randomUUID(),
    expenseId: randomUUID(),
    offlineCustomerId: randomUUID(),
  };
  const password = `S21-${randomUUID()}!Aa1`;
  const storage = new IntegratedAttachmentStorage();
  const scanner = new IntegratedAttachmentScanner();
  const nullLogs = new NullLogDestination();
  const originalEnvironment = {
    APP_ENV: process.env.APP_ENV,
    LOG_LEVEL: process.env.LOG_LEVEL,
    DATABASE_URL: process.env.DATABASE_URL,
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    AUTH_DATABASE_URL: process.env.AUTH_DATABASE_URL,
    REQUEST_ID_TRUST_INCOMING: process.env.REQUEST_ID_TRUST_INCOMING,
  };

  let database: InventoryTestDatabase | undefined;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  let app: INestApplication | undefined;
  let server: Server;
  let occurredAt: string;
  let license: OfflineLicenseResponse;
  let syncAuthentication: SyncAuthenticationResponse;
  let localSequence = 1n;

  const db = (): InventoryTestDatabase => {
    if (!database) throw new Error('The isolated S21 closure database is unavailable.');
    return database;
  };

  const authorization = (identity: Identity): Record<string, string> => ({
    authorization: `Bearer ${identity.accessToken}`,
  });

  async function login(identity: Identity): Promise<void> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email: identity.email,
        password,
        storeId: identity.storeId,
        deviceId: identity.deviceId,
        deviceName: 'S21 integrated closure',
        devicePlatform: 'android',
      })
      .expect(200);
    const authentication = body(response) as unknown as AuthenticationResponse;
    identity.accessToken = authentication.accessToken;
    identity.refreshToken = authentication.refreshToken;
  }

  async function notifications(
    identity: Identity,
    query: Record<string, string> = {},
  ): Promise<NotificationItem[]> {
    const response = await request(server)
      .get('/v1/notifications')
      .set(authorization(identity))
      .query(query)
      .expect(200);
    const items = body(response).items;
    if (!Array.isArray(items)) throw new Error('Expected notification items.');
    return items as NotificationItem[];
  }

  async function audit(identity: Identity, query = ''): Promise<AuditItem[]> {
    const response = await request(server)
      .get(`/v1/audit${query}`)
      .set(authorization(identity))
      .expect(200);
    const items = body(response).items;
    if (!Array.isArray(items)) throw new Error('Expected audit items.');
    return items as AuditItem[];
  }

  async function accountingSnapshot(): Promise<Record<string, string>> {
    const result = await db().admin.query<Record<string, string>>(
      `select
         (select coalesce(sum(receivable_delta_minor-credit_delta_minor),0)::text
          from ledger.customer_ledger_entries where store_id=$1) as receivable,
         (select coalesce(sum(payable_delta_minor-credit_delta_minor),0)::text
          from ledger.supplier_ledger_entries where store_id=$1) as payable,
         (select coalesce(sum(amount_delta_minor),0)::text
          from ledger.money_movements where store_id=$1) as money,
         (select coalesce(sum(quantity_delta_milli),0)::text
          from ledger.inventory_movements where store_id=$1) as inventory,
         (select coalesce(sum(amount_minor),0)::text
          from ledger.expenses where store_id=$1 and status='posted') as expenses,
         (select count(*)::text from ledger.owner_ledger_entries where store_id=$1) as owner,
         (select count(*)::text from ledger.sales where store_id=$1) as sales,
         (select count(*)::text from ledger.purchase_invoices where store_id=$1) as invoices`,
      [identities.ownerA.storeId],
    );
    const snapshot = result.rows[0];
    if (!snapshot) throw new Error('Expected an accounting snapshot.');
    return snapshot;
  }

  function offlineEnvelope(operationId: string): Record<string, unknown> {
    const signed = license.license;
    return {
      protocolVersion: 1,
      operationId,
      operationType: 'customers.create.v1',
      storeId: identities.ownerA.storeId,
      deviceId: identities.ownerA.deviceId,
      aggregateId: fixture.offlineCustomerId,
      clientRecordedAt: occurredAt,
      payload: { name: 'Offline Audit Customer', phone: '0599000199' },
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
      localSequence: (localSequence++).toString(),
      dependsOnOperationIds: [],
    };
  }

  beforeAll(async () => {
    if (!environment) throw new Error('Approved local PostgreSQL test environment required.');
    database = await createInventoryTestDatabase();
    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      await applyMigration(migrator, db().file);
    } finally {
      await migrator.query('reset role');
      migrator.release();
    }

    const passwordHash = await new PasswordService().hash(password);
    for (const [storeId, name] of [
      [identities.ownerA.storeId, 'S21 Integrated Store A'],
      [identities.ownerB.storeId, 'S21 Integrated Store B'],
    ] as const) {
      await db().admin.query(`insert into ledger.stores(id,name,status) values($1,$2,'active')`, [
        storeId,
        name,
      ]);
      await db().admin.query(`insert into ledger.app_settings(store_id) values($1)`, [storeId]);
    }
    for (const identity of Object.values(identities)) {
      await db().admin.query(
        `insert into platform.users(
           id,email,normalized_email,password_hash,full_name,status
         ) values($1,$2,$2,$3,$4,'active')`,
        [identity.userId, identity.email, passwordHash, identity.email.split('@')[0]],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
         values($1,$2,$3,'owner','active')`,
        [identity.membershipId, identity.storeId, identity.userId],
      );
    }

    await upgradeInventoryTestDatabaseToCurrent(db(), [
      identities.ownerA.storeId,
      identities.ownerB.storeId,
    ]);
    await db().admin.query(
      `update platform.subscription_plans
       set offline_grace_days=7,max_devices=greatest(max_devices,3)
       where status='active'`,
    );
    await db().admin.query(
      `update ledger.app_settings
       set customer_debt_amount_alert_minor=100,debt_age_alert_days=36500,
           low_stock_alert_enabled=true
       where store_id=$1`,
      [identities.ownerA.storeId],
    );

    const clock = await db().admin.query<{ occurredAt: string }>(
      `select clock_timestamp()::text as "occurredAt"`,
    );
    const databaseTime = clock.rows[0]?.occurredAt;
    if (!databaseTime) throw new Error('Database time is unavailable.');
    occurredAt = new Date(databaseTime).toISOString();
    const localParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Hebron',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(new Date(occurredAt));
    const year = Number(localParts.find((part) => part.type === 'year')?.value);
    const month = Number(localParts.find((part) => part.type === 'month')?.value);
    const boundaries = resolveAccountingPeriodBoundaries(year, month);
    await db().admin.query(
      `insert into ledger.accounting_periods(
         id,store_id,period_year,period_month,starts_at,ends_at,status,operation_id
       ) values($1,$2,$3,$4,$5,$6,'open',$7)`,
      [
        deriveAccountingPeriodId(identities.ownerA.storeId, year, month),
        identities.ownerA.storeId,
        year,
        month,
        boundaries.startsAt,
        boundaries.endsAt,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.money_accounts(
         id,store_id,name,normalized_name,account_type,availability,is_default,status,operation_id
       ) values($1,$2,'S21 Integrated Cash','s21 integrated cash','cash','available',true,'active',$3)`,
      [fixture.moneyAccountId, identities.ownerA.storeId, randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.expense_categories(
         id,store_id,name,normalized_name,status,operation_id
       ) values($1,$2,'S21 Integrated Expenses','s21 integrated expenses','active',$3)`,
      [fixture.expenseCategoryId, identities.ownerA.storeId, randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.customers(
         id,store_id,name,normalized_name,phone,normalized_phone,credit_limit_minor,
         status,operation_id
       ) values($1,$2,'S21 Integrated Customer','s21 integrated customer',
         '0599000101','+970599000101',1000,'active',$3)`,
      [fixture.customerId, identities.ownerA.storeId, randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.suppliers(id,store_id,name,normalized_name,status,operation_id)
       values($1,$2,'S21 Integrated Supplier','s21 integrated supplier','active',$3)`,
      [fixture.supplierId, identities.ownerA.storeId, randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.products(
         id,store_id,name,normalized_name,measurement_type,track_inventory,
         low_stock_threshold_milli,status,operation_id
       ) values($1,$2,'S21 Integrated Product','s21 integrated product','count',true,
         1000,'active',$3)`,
      [fixture.productId, identities.ownerA.storeId, randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.product_units(
         id,store_id,product_id,measurement_type,unit_name,is_base,
         factor_num,factor_den,status,operation_id
       ) values($1,$2,$3,'count','piece',true,1,1,'active',$4)`,
      [fixture.productUnitId, identities.ownerA.storeId, fixture.productId, randomUUID()],
    );

    const databaseName = (
      await db().admin.query<{ name: string }>('select current_database() as name')
    ).rows[0]?.name;
    if (!databaseName || !/^dokana_s112_[0-9a-f]{32}$/.test(databaseName)) {
      throw new Error('The S21 closure database is not disposable.');
    }
    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'silent';
    process.env.DATABASE_URL = databaseUrl(environment.runtimeUrl, databaseName);
    process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
    process.env.AUTH_DATABASE_URL = databaseUrl(environment.authUrl, databaseName);
    process.env.REQUEST_ID_TRUST_INCOMING = 'true';
    runtimePool = createTestPool(process.env.DATABASE_URL, 'dokana-s215-runtime', 8);
    authPool = createTestPool(process.env.AUTH_DATABASE_URL, 'dokana-s215-auth', 2);

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_POOL)
      .useValue(runtimePool)
      .overrideProvider(AUTH_DATABASE_POOL)
      .useValue(authPool)
      .overrideProvider(ATTACHMENT_STORAGE)
      .useValue(storage)
      .overrideProvider(ATTACHMENT_MALWARE_SCANNER)
      .useValue(scanner)
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useFactory({
        factory: (config: AppConfigService) => createLoggingParams(config, nullLogs),
        inject: [AppConfigService],
      })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.useLogger(app.get(Logger));
    configureApplication(app as NestExpressApplication, app.get(AppConfigService));
    await app.init();
    server = app.getHttpServer() as Server;
    app.get(NotificationSchedulerService).onModuleDestroy();

    for (const identity of Object.values(identities)) await login(identity);
    license = body(
      await request(server)
        .post('/v1/licenses/verify')
        .set(authorization(identities.ownerA))
        .send({ operationId: randomUUID() })
        .expect(200),
    ) as unknown as OfflineLicenseResponse;
    syncAuthentication = body(
      await request(server)
        .post('/v1/sync/auth/token')
        .send({ refreshToken: identities.ownerA.refreshToken })
        .expect(200),
    ) as unknown as SyncAuthenticationResponse;
    const licensedClock = await db().admin.query<{ occurredAt: string }>(
      `select clock_timestamp()::text as "occurredAt"`,
    );
    const licensedTime = licensedClock.rows[0]?.occurredAt;
    if (!licensedTime) throw new Error('Licensed database time is unavailable.');
    occurredAt = new Date(licensedTime).toISOString();
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      else await Promise.all([runtimePool?.end(), authPool?.end()]);
      if (database) {
        const idle = await database.admin.query<{ count: number }>(
          `select count(*)::integer as count from pg_stat_activity
           where datname=current_database() and state like 'idle in transaction%'`,
        );
        expect(idle.rows[0]).toEqual({ count: 0 });
      }
    } finally {
      await database?.close();
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  }, 60_000);

  it('keeps notifications, audit, and attachments separate across one canonical Owner timeline', async () => {
    const owner = identities.ownerA;
    const secondOwner = identities.ownerA2;
    const foreignOwner = identities.ownerB;

    const saleOperationId = randomUUID();
    const saleResponse = await request(server)
      .post('/v1/sales')
      .set(authorization(owner))
      .send({
        operationId: saleOperationId,
        customerId: fixture.customerId,
        occurredAt,
        items: [
          {
            isManualLine: true,
            description: 'S21 integrated credit sale',
            unitName: 'service',
            quantityMilli: '1000',
            unitPriceMinor: '500',
            lineTotalMinor: '500',
          },
        ],
        payments: [],
        totalMinor: '500',
      });
    if (saleResponse.status !== 201) {
      throw new Error(`Sale fixture failed: ${JSON.stringify(saleResponse.body)}`);
    }
    const sale = body(saleResponse);
    const saleId = nestedId(sale, 'sale');
    const afterSale = await accountingSnapshot();
    const debt = await notifications(owner, {
      lifecycle: 'active',
      type: 'customer_debt_amount',
    });
    expect(await accountingSnapshot()).toEqual(afterSale);
    expect(debt).toHaveLength(1);
    expect(debt[0]).toMatchObject({
      read: false,
      lifecycle: 'active',
      subject: { type: 'customer', id: fixture.customerId },
    });
    const debtId = debt[0]?.id;
    if (!debtId) throw new Error('Expected the customer debt notification.');
    await request(server)
      .patch(`/v1/notifications/${debtId}/read-state`)
      .set(authorization(owner))
      .send({ read: true })
      .expect(200);
    expect(
      (await notifications(owner, { lifecycle: 'active', type: 'customer_debt_amount' }))[0],
    ).toMatchObject({ read: true });
    expect(
      (await notifications(secondOwner, { lifecycle: 'active', type: 'customer_debt_amount' }))[0],
    ).toMatchObject({ read: false });

    await request(server)
      .post(`/v1/customers/${fixture.customerId}/payments`)
      .set(authorization(owner))
      .send({
        operationId: randomUUID(),
        occurredAt,
        allocationMode: 'fifo',
        tenders: [{ moneyAccountId: fixture.moneyAccountId, amountMinor: '500' }],
      })
      .expect(201);
    expect(
      await notifications(owner, { lifecycle: 'active', type: 'customer_debt_amount' }),
    ).toEqual([]);
    expect(
      await notifications(owner, { lifecycle: 'resolved', type: 'customer_debt_amount' }),
    ).toEqual([expect.objectContaining({ id: debtId, lifecycle: 'resolved' })]);

    const invoice = body(
      await request(server)
        .post(`/v1/suppliers/${fixture.supplierId}/invoices`)
        .set(authorization(owner))
        .send({
          operationId: randomUUID(),
          invoiceNumber: 'S21-INTEGRATED-1',
          occurredAt,
          dueAt: occurredAt,
          items: [
            {
              description: 'Payable-only S21 item',
              unitName: 'piece',
              quantityMilli: '1000',
              unitCostMinor: '500',
              lineTotalMinor: '500',
            },
          ],
          totalMinor: '500',
        })
        .expect(201),
    );
    const invoiceId = nestedId(invoice, 'invoice');
    const invoiceAuthority = await db().admin.query<{
      status: string;
      dueDate: string | null;
      businessDate: string;
      outstanding: string;
    }>(
      `select invoice.status,
              (invoice.due_at at time zone settings.timezone_name)::date::text as "dueDate",
              (clock_timestamp() at time zone settings.timezone_name)::date::text as "businessDate",
              outstanding.outstanding_minor::text as outstanding
       from ledger.purchase_invoices invoice
       join ledger.app_settings settings on settings.store_id=invoice.store_id
       join ledger.v_supplier_invoice_outstanding outstanding
         on outstanding.store_id=invoice.store_id
        and outstanding.purchase_invoice_id=invoice.id
       where invoice.store_id=$1 and invoice.id=$2`,
      [owner.storeId, invoiceId],
    );
    expect(invoiceAuthority.rows[0]).toMatchObject({
      status: 'open',
      outstanding: '500',
      dueDate: invoiceAuthority.rows[0]?.businessDate,
    });
    expect(await notifications(owner, { lifecycle: 'active', type: 'supplier_due' })).toEqual([
      expect.objectContaining({
        subject: { type: 'supplier_invoice', id: invoiceId },
      }),
    ]);
    await request(server)
      .post(`/v1/suppliers/${fixture.supplierId}/payments`)
      .set(authorization(owner))
      .send({
        operationId: randomUUID(),
        paymentSource: 'money_account',
        moneyAccountId: fixture.moneyAccountId,
        amountMinor: '500',
        occurredAt,
        allocations: [{ targetType: 'purchase_invoice', targetId: invoiceId, amountMinor: '500' }],
      })
      .expect(201);
    const settledInvoice = await db().admin.query<{
      obligation: string;
      allocated: string;
      outstanding: string;
    }>(
      `select outstanding.outstanding_minor::text as obligation,
              coalesce(sum(allocation.amount_minor),0)::text as allocated,
              (outstanding.outstanding_minor-
                coalesce(sum(allocation.amount_minor),0))::text as outstanding
       from ledger.v_supplier_invoice_outstanding outstanding
       left join ledger.supplier_payment_allocations allocation
         on allocation.store_id=outstanding.store_id
        and allocation.purchase_invoice_id=outstanding.purchase_invoice_id
       where outstanding.store_id=$1 and outstanding.purchase_invoice_id=$2
       group by outstanding.outstanding_minor`,
      [owner.storeId, invoiceId],
    );
    expect(settledInvoice.rows[0]).toEqual({
      obligation: '500',
      allocated: '500',
      outstanding: '0',
    });
    const repository = app?.get(NotificationRepository);
    if (!repository) throw new Error('NotificationRepository is unavailable.');
    await repository.reconcile({
      storeId: owner.storeId,
      userId: owner.userId,
      deviceId: owner.deviceId,
      requestId: randomUUID(),
    });
    expect(await notifications(owner, { lifecycle: 'active', type: 'supplier_due' })).toEqual([]);

    await request(server)
      .post('/v1/expenses')
      .set(authorization(owner))
      .send({
        id: fixture.expenseId,
        operationId: randomUUID(),
        categoryId: fixture.expenseCategoryId,
        description: 'S21 integrated due expense',
        amountMinor: '300',
        occurredAt,
        dueAt: occurredAt,
        mode: 'DUE',
      })
      .expect(201);
    expect(await notifications(owner, { lifecycle: 'active', type: 'expense_due' })).toEqual([
      expect.objectContaining({ subject: { type: 'expense', id: fixture.expenseId } }),
    ]);

    await request(server)
      .post('/v1/inventory/increase')
      .set(authorization(owner))
      .send({
        operationId: randomUUID(),
        productId: fixture.productId,
        productUnitId: fixture.productUnitId,
        selectedQuantityMilli: '1000',
        totalPurchaseCostMinor: '200',
        occurredAt,
      })
      .expect(201);
    expect(await notifications(owner, { lifecycle: 'active', type: 'low_stock' })).toEqual([
      expect.objectContaining({ subject: { type: 'product', id: fixture.productId } }),
    ]);

    const offlineOperationId = randomUUID();
    const offlineOperation = offlineEnvelope(offlineOperationId);
    const firstPush = body(
      await request(server)
        .post('/v1/sync/push')
        .set('authorization', `Bearer ${syncAuthentication.syncToken}`)
        .send({ operations: [offlineOperation] })
        .expect(200),
    );
    expect(firstPush.results).toEqual([
      expect.objectContaining<Partial<OfflineOperationPushResult>>({ status: 'APPLIED' }),
    ]);
    const replay = body(
      await request(server)
        .post('/v1/sync/push')
        .set('authorization', `Bearer ${syncAuthentication.syncToken}`)
        .send({ operations: [offlineOperation] })
        .expect(200),
    );
    expect(replay.results).toEqual([
      expect.objectContaining<Partial<OfflineOperationPushResult>>({ status: 'EXACT_REPLAY' }),
    ]);

    const accountingBeforeSupport = await accountingSnapshot();
    const receipt = Buffer.from('%PDF-1.7\nS21 integrated receipt\n%%EOF');
    const uploaded = body(
      await request(server)
        .post('/v1/attachments')
        .set(authorization(owner))
        .field('entityType', 'expense')
        .field('entityId', fixture.expenseId)
        .attach('file', receipt, { filename: 'receipt.pdf', contentType: 'application/pdf' })
        .expect(201),
    );
    const attachmentId = stringField(uploaded, 'id');
    expect(uploaded).not.toHaveProperty('remoteKey');
    expect(uploaded).not.toHaveProperty('bucket');
    await request(server)
      .get(`/v1/attachments?entityType=expense&entityId=${encodeURIComponent(fixture.expenseId)}`)
      .set(authorization(owner))
      .expect(200);
    await request(server)
      .get(`/v1/attachments/${attachmentId}/content`)
      .set(authorization(owner))
      .expect(200)
      .expect(receipt);
    await request(server)
      .get(`/v1/attachments/${attachmentId}/content`)
      .set(authorization(foreignOwner))
      .expect(404);
    await request(server)
      .delete(`/v1/attachments/${attachmentId}`)
      .set(authorization(owner))
      .expect(200);
    await request(server)
      .get(`/v1/attachments/${attachmentId}/content`)
      .set(authorization(owner))
      .expect(404);

    const timeline = await audit(owner, '?limit=100');
    const actions = timeline.map((item) => item.action);
    for (const action of [
      'SALE_CREATED',
      'CUSTOMER_COLLECTION_CREATED',
      'SUPPLIER_INVOICE_CREATED',
      'SUPPLIER_PAYMENT_CREATED',
      'EXPENSE_CREATED',
      'MANUAL_INVENTORY_CREATED',
      'CUSTOMER_CREATED',
      'ATTACHMENT_ADDED',
      'ATTACHMENT_REMOVED',
    ]) {
      expect(actions.filter((candidate) => candidate === action)).toHaveLength(1);
    }
    expect(timeline.find((item) => item.action === 'SALE_CREATED')).toMatchObject({
      entity: { type: 'sale', id: saleId },
      actor: { type: 'user', userId: owner.userId },
    });
    expect(timeline.find((item) => item.action === 'CUSTOMER_CREATED')).toMatchObject({
      entity: { type: 'customer', id: fixture.offlineCustomerId },
      actor: { type: 'user', userId: owner.userId },
    });
    expect(timeline.find((item) => item.action === 'ATTACHMENT_ADDED')).toMatchObject({
      entity: { type: 'attachment', id: attachmentId },
      actor: { type: 'user', userId: owner.userId },
    });
    expect(await audit(secondOwner, '?limit=100')).toEqual(timeline);
    expect(await audit(foreignOwner, '?limit=100')).toEqual([]);
    expect(await notifications(foreignOwner)).toEqual([]);

    const exposed = JSON.stringify({ timeline, notifications: await notifications(owner) });
    for (const prohibited of [
      'password_hash',
      'access_token',
      'refresh_token',
      'session_id',
      'request_hash',
      'remote_key',
      'bucket',
      'scanner',
      'objectKey',
      'privateKey',
    ]) {
      expect(exposed).not.toContain(prohibited);
    }
    expect(await accountingSnapshot()).toEqual(accountingBeforeSupport);
  });
});
