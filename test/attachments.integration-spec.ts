import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

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
import { AttachmentService } from '../src/attachments/attachment.service';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import {
  createTestPool,
  provisionActiveTestEntitlements,
  readLocalPostgresTestEnvironment,
  removeActiveTestEntitlements,
  type ActiveTestEntitlementFixture,
} from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const fixture = {
  stores: {
    a: 'b2100000-0000-4000-8000-000000000001',
    b: 'b2100000-0000-4000-8000-000000000002',
    readOnly: 'b2100000-0000-4000-8000-000000000003',
  },
  users: {
    ownerA: 'b2200000-0000-4000-8000-000000000001',
    managerA: 'b2200000-0000-4000-8000-000000000002',
    ownerB: 'b2200000-0000-4000-8000-000000000003',
    readOnly: 'b2200000-0000-4000-8000-000000000004',
  },
  memberships: {
    ownerA: 'b2300000-0000-4000-8000-000000000001',
    managerA: 'b2300000-0000-4000-8000-000000000002',
    ownerB: 'b2300000-0000-4000-8000-000000000003',
    readOnly: 'b2300000-0000-4000-8000-000000000004',
  },
  devices: {
    ownerA: 'b2400001-0001-4000-8000-000000000001',
    managerA: 'b2400002-0002-4000-8000-000000000002',
    ownerB: 'b2400003-0003-4000-8000-000000000003',
    readOnly: 'b2400004-0004-4000-8000-000000000004',
  },
  parents: {
    customer: 'b2500000-0000-4000-8000-000000000001',
    product: 'b2500000-0000-4000-8000-000000000002',
    supplier: 'b2500000-0000-4000-8000-000000000003',
    expense: 'b2500000-0000-4000-8000-000000000004',
    storeB: 'b2500000-0000-4000-8000-000000000005',
    readOnly: 'b2500000-0000-4000-8000-000000000006',
    concurrency: 'b2500000-0000-4000-8000-000000000007',
  },
  emails: {
    ownerA: 's21-attachments-owner-a@example.test',
    managerA: 's21-attachments-manager-a@example.test',
    ownerB: 's21-attachments-owner-b@example.test',
    readOnly: 's21-attachments-read-only@example.test',
  },
  password: 'S21-Attachments-Test-Password!',
};

type AccessKey = keyof typeof fixture.emails;
interface AccessIdentity {
  accessToken: string;
  storeId: string;
  userId: string;
  deviceId: string;
}

const storeByAccess: Readonly<Record<AccessKey, string>> = {
  ownerA: fixture.stores.a,
  managerA: fixture.stores.a,
  ownerB: fixture.stores.b,
  readOnly: fixture.stores.readOnly,
};
const roleByAccess: Readonly<Record<AccessKey, 'owner' | 'manager'>> = {
  ownerA: 'owner',
  managerA: 'manager',
  ownerB: 'owner',
  readOnly: 'owner',
};

class NullLogDestination implements DestinationStream {
  write(): void {
    return;
  }
}

class IntegrationAttachmentStorage implements AttachmentStoragePort {
  readonly objects = new Map<string, { body: Buffer; lastModified: Date }>();
  readonly getKeys: string[] = [];

  putObject(input: PutAttachmentObjectInput): Promise<void> {
    if (this.objects.has(input.key)) return Promise.reject(new Error('duplicate'));
    this.objects.set(input.key, { body: Buffer.from(input.body), lastModified: new Date() });
    return Promise.resolve();
  }

  getObject(key: string): Promise<StoredAttachmentObject | null> {
    this.getKeys.push(key);
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
        .map(([key, value]) => ({ key, lastModified: value.lastModified })),
      nextToken: null,
    });
  }
}

class IntegrationAttachmentScanner implements AttachmentMalwareScannerPort {
  result: AttachmentScanResult = 'clean';
  scan(): Promise<AttachmentScanResult> {
    return Promise.resolve(this.result);
  }
}

function pdf(): Buffer {
  return Buffer.from('%PDF-1.7\nS21 attachment\n%%EOF');
}

function jpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
}

function png(): Buffer {
  return Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ]);
}

function responseBody(response: Response): Record<string, unknown> {
  if (typeof response.body !== 'object' || response.body === null || Array.isArray(response.body)) {
    throw new Error('Expected an object response body.');
  }
  return response.body as Record<string, unknown>;
}

function responseString(response: Response, field: string): string {
  const value = responseBody(response)[field];
  if (typeof value !== 'string') throw new Error(`Expected ${field} string.`);
  return value;
}

describe('secure attachments with real PostgreSQL', () => {
  const storage = new IntegrationAttachmentStorage();
  const scanner = new IntegrationAttachmentScanner();
  const nullLogs = new NullLogDestination();
  let app: INestApplication | undefined;
  let server: Server;
  let fixturePool: Pool;
  let poolsInitialized = false;
  let entitlementFixture: ActiveTestEntitlementFixture | undefined;
  let access: Record<AccessKey, AccessIdentity>;

  async function removeFixtures(): Promise<void> {
    const storeIds = Object.values(fixture.stores);
    const userIds = Object.values(fixture.users);
    await fixturePool.query(
      `delete from platform.refresh_tokens where session_id in (
         select id from platform.auth_sessions where user_id=any($1::uuid[])
       )`,
      [userIds],
    );
    await fixturePool.query(`delete from platform.auth_sessions where user_id=any($1::uuid[])`, [
      userIds,
    ]);
    await fixturePool.query(`delete from audit.central_audit_logs where store_id=any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.attachments where store_id=any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.expenses where store_id=any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.products where store_id=any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.suppliers where store_id=any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.customers where store_id=any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.devices where store_id=any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(
      `delete from platform.store_memberships where store_id=any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from platform.users where id=any($1::uuid[])`, [userIds]);
    await removeActiveTestEntitlements(fixturePool, entitlementFixture);
    entitlementFixture = undefined;
    await fixturePool.query(`delete from ledger.stores where id=any($1::uuid[])`, [storeIds]);
  }

  async function login(key: AccessKey): Promise<AccessIdentity> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email: fixture.emails[key],
        password: fixture.password,
        storeId: storeByAccess[key],
        deviceId: fixture.devices[key],
        deviceName: `S21 attachments ${key}`,
        devicePlatform: 'android',
      });
    if (response.status !== 200) throw new Error(`Attachment login ${key} failed.`);
    return {
      accessToken: responseString(response, 'accessToken'),
      storeId: storeByAccess[key],
      userId: fixture.users[key],
      deviceId: fixture.devices[key],
    };
  }

  function authorized(identity: AccessIdentity, method: 'get' | 'delete', path: string) {
    return request(server)[method](path).set('authorization', `Bearer ${identity.accessToken}`);
  }

  function upload(
    identity: AccessIdentity,
    entityType: string,
    entityId: string,
    content: Buffer,
    filename: string,
    contentType: string,
  ) {
    return request(server)
      .post('/v1/attachments')
      .set('authorization', `Bearer ${identity.accessToken}`)
      .field('entityType', entityType)
      .field('entityId', entityId)
      .attach('file', content, { filename, contentType });
  }

  async function resetAttachmentState(): Promise<void> {
    await fixturePool.query(
      `delete from audit.central_audit_logs
       where store_id=any($1::uuid[]) and entity_type='ledger.attachments'`,
      [Object.values(fixture.stores)],
    );
    await fixturePool.query(`delete from ledger.attachments where store_id=any($1::uuid[])`, [
      Object.values(fixture.stores),
    ]);
    await fixturePool.query(`update ledger.stores set status='active' where id=any($1::uuid[])`, [
      Object.values(fixture.stores),
    ]);
    await fixturePool.query(
      `update ledger.customers set status='active',archived_at=null
       where id in ($1,$2,$3,$4)`,
      [
        fixture.parents.customer,
        fixture.parents.storeB,
        fixture.parents.readOnly,
        fixture.parents.concurrency,
      ],
    );
    storage.objects.clear();
    storage.getKeys.length = 0;
    scanner.result = 'clean';
  }

  async function accountingSnapshot(): Promise<Record<string, string>> {
    const result = await fixturePool.query<Record<string, string>>(
      `select
         (select amount_minor::text from ledger.expenses where id=$2) as "expenseAmount",
         (select paid_total_minor::text from ledger.expenses where id=$2) as "expensePaid",
         (select count(*)::text from ledger.expense_payments where store_id=$1) as "expensePayments",
         (select count(*)::text from ledger.customer_ledger_entries where store_id=$1) as receivables,
         (select count(*)::text from ledger.supplier_ledger_entries where store_id=$1) as payables,
         (select count(*)::text from ledger.money_movements where store_id=$1) as money,
         (select count(*)::text from ledger.inventory_movements where store_id=$1) as inventory,
         (select count(*)::text from ledger.accounting_periods where store_id=$1) as periods`,
      [fixture.stores.a, fixture.parents.expense],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Expected accounting snapshot.');
    return row;
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL test environment is unavailable.');
    }
    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'info';
    process.env.DATABASE_URL = environment.runtimeUrl;
    process.env.AUTH_DATABASE_URL = environment.authUrl;
    fixturePool = createTestPool(
      environment.adminUrl,
      'dokana-s21-attachments-fixtures',
      4,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    poolsInitialized = true;
    await removeFixtures();

    for (const [key, storeId] of Object.entries(fixture.stores)) {
      await fixturePool.query(
        `insert into ledger.stores (id,name,status) values ($1,$2,'active')`,
        [storeId, `S21 attachments ${key}`],
      );
    }
    const passwordHash = await new PasswordService().hash(fixture.password);
    for (const key of Object.keys(fixture.emails) as AccessKey[]) {
      await fixturePool.query(
        `insert into platform.users (
           id,email,normalized_email,password_hash,full_name,status
         ) values ($1,$2,$2,$3,$4,'active')`,
        [fixture.users[key], fixture.emails[key], passwordHash, `S21 attachments ${key}`],
      );
      await fixturePool.query(
        `insert into platform.store_memberships (id,store_id,user_id,role,status)
         values ($1,$2,$3,$4,'active')`,
        [fixture.memberships[key], storeByAccess[key], fixture.users[key], roleByAccess[key]],
      );
    }

    const customers = [
      [fixture.parents.customer, fixture.stores.a, 'Primary'],
      [fixture.parents.concurrency, fixture.stores.a, 'Concurrent'],
      [fixture.parents.storeB, fixture.stores.b, 'Foreign'],
      [fixture.parents.readOnly, fixture.stores.readOnly, 'Read Only'],
    ] satisfies readonly (readonly [string, string, string])[];
    for (const [id, storeId, name] of customers) {
      const phone = `+97059${id.slice(-7)}`;
      await fixturePool.query(
        `insert into ledger.customers (
           id,store_id,name,normalized_name,phone,normalized_phone,status,operation_id
         ) values ($1,$2,$3,lower($3),$4,$4,'active',$5)`,
        [id, storeId, name, phone, randomUUID()],
      );
    }
    await fixturePool.query(
      `insert into ledger.products (
         id,store_id,name,normalized_name,measurement_type,track_inventory,status,operation_id
       ) values ($1,$2,'Attachment Product','attachment product','count',true,'active',$3)`,
      [fixture.parents.product, fixture.stores.a, randomUUID()],
    );
    await fixturePool.query(
      `insert into ledger.suppliers (
         id,store_id,name,normalized_name,status,operation_id
       ) values ($1,$2,'Attachment Supplier','attachment supplier','active',$3)`,
      [fixture.parents.supplier, fixture.stores.a, randomUUID()],
    );
    await fixturePool.query(
      `insert into ledger.expenses (
         id,store_id,description,amount_minor,paid_total_minor,expense_at,
         payment_timing,status,operation_id
       ) values ($1,$2,'Attachment Expense',1000,0,clock_timestamp(),'due_later','posted',$3)`,
      [fixture.parents.expense, fixture.stores.a, randomUUID()],
    );
    entitlementFixture = await provisionActiveTestEntitlements(
      fixturePool,
      Object.values(fixture.stores),
    );

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
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
    const nestApp = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    nestApp.useLogger(nestApp.get(Logger));
    configureApplication(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp;
    server = nestApp.getHttpServer();

    access = {} as Record<AccessKey, AccessIdentity>;
    for (const key of Object.keys(fixture.emails) as AccessKey[]) access[key] = await login(key);
  }, 90_000);

  beforeEach(async () => {
    await resetAttachmentState();
  });

  afterAll(async () => {
    await app?.close();
    if (!poolsInitialized) return;
    await removeFixtures();
    const residue = await fixturePool.query<{ count: number }>(
      `select (
         (select count(*) from audit.central_audit_logs where store_id=any($1::uuid[])) +
         (select count(*) from ledger.attachments where store_id=any($1::uuid[])) +
         (select count(*) from ledger.expenses where store_id=any($1::uuid[])) +
         (select count(*) from ledger.products where store_id=any($1::uuid[])) +
         (select count(*) from ledger.suppliers where store_id=any($1::uuid[])) +
         (select count(*) from ledger.customers where store_id=any($1::uuid[])) +
         (select count(*) from ledger.devices where store_id=any($1::uuid[])) +
         (select count(*) from platform.store_memberships where store_id=any($1::uuid[])) +
         (select count(*) from platform.users where id=any($2::uuid[])) +
         (select count(*) from ledger.stores where id=any($1::uuid[]))
       )::integer as count`,
      [Object.values(fixture.stores), Object.values(fixture.users)],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await fixturePool.end();
  }, 60_000);

  it('supports only the four approved parents with safe metadata and no accounting effect', async () => {
    const before = await accountingSnapshot();
    const cases = [
      ['customer', fixture.parents.customer, pdf(), 'customer.pdf', 'application/pdf'],
      ['product', fixture.parents.product, jpeg(), 'product.jpg', 'image/jpeg'],
      ['supplier', fixture.parents.supplier, png(), 'supplier.png', 'image/png'],
      ['expense', fixture.parents.expense, pdf(), 'expense.pdf', 'application/pdf'],
    ] as const;
    const ids: string[] = [];
    for (const [entityType, entityId, content, filename, contentType] of cases) {
      const response = await upload(
        access.ownerA,
        entityType,
        entityId,
        content,
        filename,
        contentType,
      ).expect(201);
      const body = responseBody(response);
      expect(body).toMatchObject({
        entityType,
        entityId,
        originalFilename: filename,
        mediaType: contentType,
      });
      expect(body).not.toHaveProperty('remoteKey');
      expect(body).not.toHaveProperty('bucket');
      expect(body).not.toHaveProperty('scanner');
      ids.push(responseString(response, 'id'));
    }

    await upload(access.ownerA, 'sale', randomUUID(), pdf(), 'sale.pdf', 'application/pdf')
      .expect(400)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'VALIDATION_ERROR' }));
    await upload(
      access.ownerA,
      'customer',
      fixture.parents.customer,
      Buffer.from('MZ executable'),
      'spoof.jpg',
      'image/jpeg',
    )
      .expect(400)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'ATTACHMENT_FILE_INVALID' }));

    const list = await authorized(
      access.ownerA,
      'get',
      `/v1/attachments?entityType=customer&entityId=${fixture.parents.customer}`,
    ).expect(200);
    const firstAttachmentId = ids[0];
    if (!firstAttachmentId) throw new Error('Expected a Customer attachment fixture.');
    expect(responseBody(list).items).toEqual([
      expect.objectContaining({ id: firstAttachmentId, originalFilename: 'customer.pdf' }),
    ]);
    const metadata = await authorized(
      access.ownerA,
      'get',
      `/v1/attachments/${firstAttachmentId}`,
    ).expect(200);
    expect(responseBody(metadata)).not.toHaveProperty('remoteKey');
    const content = await authorized(
      access.ownerA,
      'get',
      `/v1/attachments/${firstAttachmentId}/content`,
    ).expect(200);
    expect(content.body).toEqual(pdf());
    expect(content.headers['content-type']).toContain('application/pdf');
    expect(content.headers['content-disposition']).toContain('customer.pdf');
    expect(content.headers['cache-control']).toBe('private, no-store');
    expect(content.headers['x-content-type-options']).toBe('nosniff');

    const after = await accountingSnapshot();
    expect(after).toEqual(before);
  });

  it('fails closed for malware/scanner failures and compensates all rejected writes', async () => {
    scanner.result = 'infected';
    await upload(
      access.ownerA,
      'customer',
      fixture.parents.customer,
      pdf(),
      'infected.pdf',
      'application/pdf',
    )
      .expect(422)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'ATTACHMENT_MALWARE_DETECTED' }));
    scanner.result = 'unknown';
    await upload(
      access.ownerA,
      'customer',
      fixture.parents.customer,
      pdf(),
      'unknown.pdf',
      'application/pdf',
    )
      .expect(503)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'ATTACHMENT_SCANNER_UNAVAILABLE' }));
    expect(storage.objects.size).toBe(0);
    const count = await fixturePool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.attachments where store_id=$1`,
      [fixture.stores.a],
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it('enforces Owner, Store, archived-parent, and READ_ONLY boundaries without binary probing', async () => {
    await request(server).get('/v1/attachments').expect(401);
    await authorized(
      access.managerA,
      'get',
      `/v1/attachments?entityType=customer&entityId=${fixture.parents.customer}`,
    )
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'ATTACHMENT_ACCESS_NOT_ALLOWED' }));

    const created = await upload(
      access.ownerA,
      'customer',
      fixture.parents.customer,
      pdf(),
      'private.pdf',
      'application/pdf',
    ).expect(201);
    const attachmentId = responseString(created, 'id');
    const getsBefore = storage.getKeys.length;
    await authorized(access.ownerB, 'get', `/v1/attachments/${attachmentId}/content`).expect(404);
    expect(storage.getKeys.length).toBe(getsBefore);

    await fixturePool.query(
      `update ledger.customers set status='archived',archived_at=clock_timestamp()
       where id=$1`,
      [fixture.parents.customer],
    );
    await authorized(
      access.ownerA,
      'get',
      `/v1/attachments?entityType=customer&entityId=${fixture.parents.customer}`,
    ).expect(200);
    await upload(
      access.ownerA,
      'customer',
      fixture.parents.customer,
      pdf(),
      'blocked.pdf',
      'application/pdf',
    )
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'ATTACHMENT_PARENT_NOT_WRITABLE' }));

    const readOnlyCreated = await upload(
      access.readOnly,
      'customer',
      fixture.parents.readOnly,
      pdf(),
      'read-only.pdf',
      'application/pdf',
    ).expect(201);
    const readOnlyId = responseString(readOnlyCreated, 'id');
    await fixturePool.query(`update ledger.stores set status='read_only' where id=$1`, [
      fixture.stores.readOnly,
    ]);
    await authorized(
      access.readOnly,
      'get',
      `/v1/attachments?entityType=customer&entityId=${fixture.parents.readOnly}`,
    ).expect(200);
    await authorized(access.readOnly, 'get', `/v1/attachments/${readOnlyId}/content`).expect(200);
    await upload(
      access.readOnly,
      'customer',
      fixture.parents.readOnly,
      pdf(),
      'blocked-read-only.pdf',
      'application/pdf',
    )
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' }));
    await authorized(access.readOnly, 'delete', `/v1/attachments/${readOnlyId}`)
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' }));
  });

  it('serializes 9+2 concurrent uploads at 10 and compensates the rejected object', async () => {
    for (let index = 0; index < 9; index += 1) {
      const id = randomUUID();
      await fixturePool.query(
        `insert into ledger.attachments (
           id,store_id,entity_type,entity_id,kind,file_name,mime_type,remote_key,
           file_size_bytes,checksum_sha256,sync_status
         ) values ($1,$2,'customer',$3,'document',$4,'application/pdf',$5,$6,$7,'uploaded')`,
        [
          id,
          fixture.stores.a,
          fixture.parents.concurrency,
          `seed-${String(index)}.pdf`,
          `stores/${fixture.stores.a}/attachments/${id}`,
          pdf().byteLength,
          createHash('sha256').update(pdf()).digest('hex'),
        ],
      );
    }
    const results = await Promise.all([
      upload(
        access.ownerA,
        'customer',
        fixture.parents.concurrency,
        pdf(),
        'concurrent-a.pdf',
        'application/pdf',
      ),
      upload(
        access.ownerA,
        'customer',
        fixture.parents.concurrency,
        pdf(),
        'concurrent-b.pdf',
        'application/pdf',
      ),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const count = await fixturePool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.attachments
       where store_id=$1 and entity_type='customer' and entity_id=$2 and removed_at is null`,
      [fixture.stores.a, fixture.parents.concurrency],
    );
    expect(count.rows[0]?.count).toBe(10);
    expect(storage.objects.size).toBe(1);
  });

  it('logically removes, audits safely, and performs bounded retention cleanup', async () => {
    const created = await upload(
      access.ownerA,
      'expense',
      fixture.parents.expense,
      pdf(),
      'receipt.pdf',
      'application/pdf',
    ).expect(201);
    const attachmentId = responseString(created, 'id');
    const before = await accountingSnapshot();
    await authorized(access.ownerA, 'delete', `/v1/attachments/${attachmentId}`).expect(200);
    await authorized(access.ownerA, 'get', `/v1/attachments/${attachmentId}`).expect(404);
    await authorized(access.ownerA, 'get', `/v1/attachments/${attachmentId}/content`).expect(404);
    expect(storage.objects.size).toBe(1);

    const audit = await authorized(access.ownerA, 'get', '/v1/audit?entityType=attachment').expect(
      200,
    );
    const auditJson = JSON.stringify(responseBody(audit));
    expect(auditJson).toContain('ATTACHMENT_ADDED');
    expect(auditJson).toContain('ATTACHMENT_REMOVED');
    expect(auditJson).not.toContain(`stores/${fixture.stores.a}/attachments/`);
    expect(auditJson).not.toContain('scanner');
    expect(auditJson).not.toContain('bucket');

    const metadata = await fixturePool.query<{ remoteKey: string; removedBy: string }>(
      `select remote_key as "remoteKey",removed_by_user_id as "removedBy"
       from ledger.attachments where id=$1`,
      [attachmentId],
    );
    expect(metadata.rows[0]?.removedBy).toBe(fixture.users.ownerA);
    const service = app?.get(AttachmentService);
    if (!service) throw new Error('AttachmentService was unavailable.');
    const context = {
      storeId: fixture.stores.a,
      userId: fixture.users.ownerA,
      deviceId: fixture.devices.ownerA,
      requestId: randomUUID(),
    };
    expect(
      await service.purgeRemovedBinaries(context, new Date('2026-10-18T12:00:00.000Z')),
    ).toMatchObject({ deleted: 0 });
    await fixturePool.query(
      `update ledger.attachments set removed_at=clock_timestamp()-interval '31 days' where id=$1`,
      [attachmentId],
    );
    expect(await service.purgeRemovedBinaries(context, new Date(Date.now() + 1000))).toMatchObject({
      examined: 1,
      deleted: 1,
      failed: 0,
    });
    expect(storage.objects.size).toBe(0);
    const tombstone = await fixturePool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.attachments where id=$1 and removed_at is not null`,
      [attachmentId],
    );
    expect(tombstone.rows[0]?.count).toBe(1);

    const oldOrphan = `stores/${fixture.stores.a}/attachments/${randomUUID()}`;
    const recentOrphan = `stores/${fixture.stores.a}/attachments/${randomUUID()}`;
    storage.objects.set(oldOrphan, {
      body: Buffer.from('old'),
      lastModified: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    storage.objects.set(recentOrphan, { body: Buffer.from('recent'), lastModified: new Date() });
    expect(await service.purgeOrphanBinaries(context, new Date())).toMatchObject({
      examined: 2,
      deleted: 1,
      failed: 0,
    });
    expect(storage.objects.has(oldOrphan)).toBe(false);
    expect(storage.objects.has(recentOrphan)).toBe(true);
    expect(await accountingSnapshot()).toEqual(before);
  });
});
