import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

interface SqliteColumnRow {
  name: string;
  type: string;
  notNull: number;
  dflt_value: string | null;
  pk: number;
}

interface SqliteObjectRow {
  name: string;
  sql: string | null;
}

const referenceRoot = resolve(process.cwd(), 'database/reference/backend_database_reference');
const baseSchemaPath = join(referenceRoot, 'sqlite_shop_ledger_schema_v1_1.sql');
const emptyDatabasePath = join(referenceRoot, 'sqlite_shop_ledger_schema_v1_1_empty.db');
const settingsPatchPath = join(referenceRoot, 'sqlite_v1_2_settings_patch.sql');
const syncParityPatchPath = join(referenceRoot, 'sqlite_v1_3_sync_parity_patch.sql');

const baseSchema = readFileSync(baseSchemaPath, 'utf8');
const settingsPatch = readFileSync(settingsPatchPath, 'utf8');
const syncParityPatch = readFileSync(syncParityPatchPath, 'utf8');

const ids = {
  store: '00000000-0000-4000-8000-000000000001',
  device: '00000000-0000-4000-8000-000000000002',
  otherDevice: '00000000-0000-4000-8000-000000000003',
  customer: '00000000-0000-4000-8000-000000000004',
  moneyAccount: '00000000-0000-4000-8000-000000000005',
  period: '00000000-0000-4000-8000-000000000006',
  sale: '00000000-0000-4000-8000-000000000007',
  product: '00000000-0000-4000-8000-000000000008',
  productUnit: '00000000-0000-4000-8000-000000000009',
  license: '00000000-0000-4000-8000-000000000010',
  legacyLicense: '00000000-0000-4000-8000-000000000011',
} as const;

const issuedAt = 1_760_000_000_000;
const offlineValidUntil = issuedAt + 3 * 24 * 60 * 60 * 1_000;
const entitlementEnd = issuedAt + 7 * 24 * 60 * 60 * 1_000;
const issuedAtSql = String(issuedAt);
const issuedAtPlusOneSql = String(issuedAt + 1);
const issuedAtPlusTwoSql = String(issuedAt + 2);
const periodStartSql = String(issuedAt - 86_400_000);
const periodEndSql = String(issuedAt + 31 * 86_400_000);
const offlineValidUntilSql = String(offlineValidUntil);
const entitlementEndSql = String(entitlementEnd);

function createCurrentDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(baseSchema);
  database.exec(settingsPatch);
  database.exec(syncParityPatch);
  return database;
}

function tableColumns(database: DatabaseSync, table: string): SqliteColumnRow[] {
  return database
    .prepare(
      `select name, type, "notnull" as "notNull", dflt_value, pk
       from pragma_table_info(?) order by cid`,
    )
    .all(table) as unknown as SqliteColumnRow[];
}

function objectSql(database: DatabaseSync, type: string, name: string): string {
  const row = database
    .prepare('select name, sql from sqlite_schema where type = ? and name = ?')
    .get(type, name) as unknown as SqliteObjectRow | undefined;
  if (!row?.sql) {
    throw new Error(`Missing SQLite ${type} ${name}.`);
  }
  return row.sql;
}

function bigintValue(statement: StatementSync, ...parameters: (string | bigint)[]): bigint {
  statement.setReadBigInts(true);
  const row = statement.get(...parameters) as unknown as { value: bigint } | undefined;
  if (!row) {
    throw new Error('Expected one SQLite bigint result row.');
  }
  return row.value;
}

function seedCoreData(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO stores (
      id, name, phone, currency_code, status, created_at, updated_at, version
    ) VALUES (
      '${ids.store}', 'Sync Contract Store', '+970599000000', 'ILS', 'active',
      ${issuedAtSql}, ${issuedAtSql}, 1
    );

    INSERT INTO devices (
      id, store_id, device_name, platform, installation_id, device_prefix,
      status, created_at, updated_at, version
    ) VALUES (
      '${ids.device}', '${ids.store}', 'Primary Device', 'android',
      'install-primary', 'P01', 'active', ${issuedAtSql}, ${issuedAtSql}, 1
    );

    INSERT INTO customers (
      id, store_id, name, normalized_name, phone, normalized_phone, status,
      operation_id, created_at, updated_at, version
    ) VALUES (
      '${ids.customer}', '${ids.store}', 'Parity Customer', 'parity customer',
      '+970599111111', '+970599111111', 'active',
      '10000000-0000-4000-8000-000000000001', ${issuedAtSql}, ${issuedAtSql}, 1
    );

    INSERT INTO money_accounts (
      id, store_id, name, normalized_name, account_type, availability,
      is_default, status, operation_id, created_at, updated_at, version
    ) VALUES (
      '${ids.moneyAccount}', '${ids.store}', 'Cash', 'cash', 'cash', 'available',
      1, 'active', '10000000-0000-4000-8000-000000000002',
      ${issuedAtSql}, ${issuedAtSql}, 1
    );

    INSERT INTO accounting_periods (
      id, store_id, period_year, period_month, starts_at, ends_at, status,
      device_id, operation_id, created_at, updated_at, version
    ) VALUES (
      '${ids.period}', '${ids.store}', 2025, 10,
      ${periodStartSql}, ${periodEndSql}, 'open',
      '${ids.device}', '10000000-0000-4000-8000-000000000003',
      ${issuedAtSql}, ${issuedAtSql}, 1
    );

    INSERT INTO sales (
      id, store_id, customer_id, accounting_period_id, display_number, sale_at,
      items_subtotal_minor, line_discount_total_minor, invoice_discount_minor,
      rounding_minor, total_minor, paid_total_minor, credit_total_minor,
      known_cost_total_minor, pending_cost_line_count, unknown_cost_line_count,
      payment_status, status, device_id, operation_id, created_at, updated_at, version
    ) VALUES (
      '${ids.sale}', '${ids.store}', '${ids.customer}', '${ids.period}', 'SALE-1',
      ${issuedAtSql}, 100, 0, 0, 0, 100, 0, 100, 0, 0, 0,
      'credit', 'posted', '${ids.device}',
      '10000000-0000-4000-8000-000000000004', ${issuedAtSql}, ${issuedAtSql}, 1
    );
  `);
}

function insertVerifiedLicense(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO offline_license_verification_keys (
      key_id, algorithm, public_key_spki, status, first_trusted_at, last_trusted_at
    ) VALUES ('offline-key-v1', 'Ed25519', 'public-spki-only', 'active',
      ${issuedAtSql}, ${issuedAtSql});

    INSERT INTO local_license (
      id, store_id, device_id, license_version, subscription_id,
      subscription_version, central_entitlement_end, signing_key_id,
      signing_algorithm, signed_payload, signature, issued_at, expires_at,
      last_trusted_server_at, last_seen_device_time, last_revalidated_at,
      verification_state, status
    ) VALUES (
      '${ids.license}', '${ids.store}', '${ids.device}', 1,
      '20000000-0000-4000-8000-000000000001', '7', ${entitlementEndSql},
      'offline-key-v1', 'Ed25519',
      '{"licenseVersion":1,"storeId":"${ids.store}","deviceId":"${ids.device}"}',
      'ed25519-signature', ${issuedAtSql}, ${offlineValidUntilSql},
      ${issuedAtSql}, ${issuedAtSql}, ${issuedAtSql}, 'verified', 'active'
    );
  `);
}

function insertOutboxOperation(
  database: DatabaseSync,
  operationId: string,
  localSequence: number | bigint,
  operationType = 'customers.create.v1',
): void {
  database
    .prepare(
      `INSERT INTO sync_outbox (
        id, store_id, device_id, operation_id, contract_state, protocol_version,
        operation_type, aggregate_id, expected_version, payload_json, occurred_at,
        client_recorded_at, offline_license_id, license_version, signing_key_id,
        subscription_id, subscription_version, signed_license_json,
        trusted_time_evidence_json, local_sequence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'v1', 1, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      operationId,
      ids.store,
      ids.device,
      operationId,
      operationType,
      operationId,
      JSON.stringify({ entityId: operationId, name: 'Offline intent' }),
      issuedAt,
      issuedAt,
      ids.license,
      'offline-key-v1',
      '20000000-0000-4000-8000-000000000001',
      '7',
      JSON.stringify({ payload: { licenseVersion: 1 }, signature: 'ed25519-signature' }),
      JSON.stringify({ stateVersion: 1, lastTrustedServerAt: issuedAt }),
      localSequence,
      issuedAt,
      issuedAt,
    );
}

describe('S19.3 SQLite offline sync parity contract', () => {
  it('creates the current schema from empty state with the expected version and integrity', () => {
    const database = createCurrentDatabase();
    try {
      expect(database.prepare('pragma user_version').get()).toEqual({ user_version: 10300 });
      expect(
        database.prepare("select value from local_meta where key = 'schema_version'").get(),
      ).toEqual({ value: '1.3.0' });
      expect(database.prepare('pragma quick_check').all()).toEqual([{ quick_check: 'ok' }]);
      expect(database.prepare('pragma foreign_key_check').all()).toEqual([]);

      const requiredTables = [
        'offline_license_verification_keys',
        'offline_trusted_time_state',
        'sync_outbox_dependencies',
        'sync_local_sequence_state',
        'sync_operation_results',
        'local_dataset_state',
        'manual_inventory_entries',
        'sale_customer_credit_applications',
      ];
      expect(
        database
          .prepare(
            `select name from sqlite_schema
             where type = 'table' and name in (${requiredTables.map(() => '?').join(', ')})
             order by name`,
          )
          .all(...requiredTables),
      ).toHaveLength(requiredTables.length);
    } finally {
      database.close();
    }
  });

  it('upgrades v1.2 data without changing identities or manufacturing accounting effects', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'dokana-s193-upgrade-'));
    const resolvedTemporaryRoot = resolve(tmpdir());
    const resolvedDirectory = resolve(temporaryDirectory);
    if (!resolvedDirectory.startsWith(`${resolvedTemporaryRoot}${sep}`)) {
      throw new Error('Refusing to use a SQLite test directory outside the temp root.');
    }
    const databasePath = join(temporaryDirectory, 'upgrade.db');
    copyFileSync(emptyDatabasePath, databasePath);
    const database = new DatabaseSync(databasePath);

    try {
      database.exec(settingsPatch);
      expect(database.prepare('pragma user_version').get()).toEqual({ user_version: 10200 });
      seedCoreData(database);
      database.exec(`
        INSERT INTO local_license (
          id, store_id, device_id, signed_payload, issued_at, expires_at,
          last_trusted_server_at, last_seen_device_time, status
        ) VALUES (
          '${ids.legacyLicense}', '${ids.store}', '${ids.device}', 'legacy-document',
          ${issuedAtSql}, ${offlineValidUntilSql}, ${issuedAtSql}, ${issuedAtSql}, 'active'
        );

        INSERT INTO sync_state (
          store_id, device_id, pull_cursor, last_push_at, last_pull_at,
          last_success_at, pending_count
        ) VALUES (
          '${ids.store}', '${ids.device}', 'legacy-cursor', ${issuedAtSql},
          ${issuedAtSql}, ${issuedAtSql}, 1
        );

        INSERT INTO sync_outbox (
          id, store_id, device_id, operation_id, aggregate_type, aggregate_id,
          action, payload_json, occurred_at, created_at, updated_at
        ) VALUES (
          '30000000-0000-4000-8000-000000000001', '${ids.store}', '${ids.device}',
          '30000000-0000-4000-8000-000000000002', 'customer', '${ids.customer}',
          'update', '{"name":"preserved"}', ${issuedAtSql}, ${issuedAtSql}, ${issuedAtSql}
        );

        INSERT INTO sync_inbox_receipts (
          id, store_id, server_event_id, entity_type, entity_id, server_version, applied_at
        ) VALUES (
          '30000000-0000-4000-8000-000000000003', '${ids.store}',
          '30000000-0000-4000-8000-000000000004', 'customer', '${ids.customer}',
          1, ${issuedAtSql}
        );

        INSERT INTO customer_payments (
          id, store_id, customer_id, money_account_id, amount_minor, payment_at,
          status, device_id, operation_id, created_at, updated_at, version
        ) VALUES (
          '30000000-0000-4000-8000-000000000005', '${ids.store}', '${ids.customer}',
          '${ids.moneyAccount}', 50, ${issuedAtSql}, 'draft', '${ids.device}',
          '30000000-0000-4000-8000-000000000006', ${issuedAtSql}, ${issuedAtSql}, 1
        );

        INSERT INTO customer_payment_allocations (
          id, store_id, customer_payment_id, sale_id, amount_minor, created_at
        ) VALUES (
          '30000000-0000-4000-8000-000000000007', '${ids.store}',
          '30000000-0000-4000-8000-000000000005', '${ids.sale}', 50, ${issuedAtSql}
        );
      `);

      database.exec(syncParityPatch);

      expect(database.prepare('pragma user_version').get()).toEqual({ user_version: 10300 });
      expect(
        database
          .prepare(
            `select verification_state as value from local_license
             where id = '${ids.legacyLicense}'`,
          )
          .get(),
      ).toEqual({ value: 'legacy_unverified' });
      expect(
        database
          .prepare(
            `select contract_state as value from sync_outbox
             where operation_id = '30000000-0000-4000-8000-000000000002'`,
          )
          .get(),
      ).toEqual({ value: 'legacy_unclassified' });
      expect(
        database
          .prepare(
            `select contract_state as value from sync_inbox_receipts
             where server_event_id = '30000000-0000-4000-8000-000000000004'`,
          )
          .get(),
      ).toEqual({ value: 'legacy' });
      expect(
        database
          .prepare(
            `select sale_id as "saleId", opening_receivable_ledger_entry_id as "openingId",
                    amount_minor as amount
             from customer_payment_allocations
             where id = '30000000-0000-4000-8000-000000000007'`,
          )
          .get(),
      ).toEqual({ saleId: ids.sale, openingId: null, amount: 50 });
      expect(database.prepare('select count(*) as value from money_movements').get()).toEqual({
        value: 0,
      });
      expect(database.prepare('select count(*) as value from inventory_movements').get()).toEqual({
        value: 0,
      });

      expect(() => database.exec(syncParityPatch)).toThrow();
      database.exec('ROLLBACK');
      expect(database.prepare('pragma user_version').get()).toEqual({ user_version: 10300 });
      expect(database.prepare('pragma quick_check').all()).toEqual([{ quick_check: 'ok' }]);
      expect(database.prepare('pragma foreign_key_check').all()).toEqual([]);

      const freshDatabase = createCurrentDatabase();
      try {
        for (const table of [
          'local_license',
          'sync_state',
          'sync_outbox',
          'sync_inbox_receipts',
          'customer_payment_allocations',
        ]) {
          expect(tableColumns(database, table)).toEqual(tableColumns(freshDatabase, table));
        }
      } finally {
        freshDatabase.close();
      }
    } finally {
      database.close();
      rmSync(resolvedDirectory, { recursive: true, force: true });
    }
  });

  it('retains the sufficient tracked/untracked Sale line contract from 0012', () => {
    const database = createCurrentDatabase();
    try {
      const columns = Object.fromEntries(
        tableColumns(database, 'sale_items').map((column) => [column.name, column]),
      );
      expect(columns.is_manual_line?.notNull).toBe(1);
      expect(columns.product_id?.notNull).toBe(0);
      expect(columns.product_unit_id?.notNull).toBe(0);
      expect(columns.base_quantity_milli?.notNull).toBe(0);
      expect(columns.inventory_movement_id?.notNull).toBe(0);
      expect(syncParityPatch).not.toMatch(/ALTER TABLE sale_items|CREATE TABLE sale_items/i);
    } finally {
      database.close();
    }
  });

  it('represents immutable Inventory reversal history and client-created Inventory roots', () => {
    const database = createCurrentDatabase();
    const exactQuantity = 9_007_199_254_740_993n;
    const exactQuantitySql = exactQuantity.toString();
    try {
      seedCoreData(database);
      database.exec(`
        INSERT INTO products (
          id, store_id, name, normalized_name, measurement_type, track_inventory,
          is_pinned, status, device_id, operation_id, created_at, updated_at, version
        ) VALUES (
          '${ids.product}', '${ids.store}', 'Parity Product', 'parity product', 'count',
          1, 0, 'active', '${ids.device}',
          '40000000-0000-4000-8000-000000000001', ${issuedAtSql}, ${issuedAtSql}, 1
        );

        INSERT INTO product_units (
          id, store_id, product_id, measurement_type, unit_name, unit_code,
          is_base, factor_num, factor_den, status, device_id, operation_id,
          created_at, updated_at, version
        ) VALUES (
          '${ids.productUnit}', '${ids.store}', '${ids.product}', 'count', 'Piece', 'pc',
          1, 1, 1, 'active', '${ids.device}',
          '40000000-0000-4000-8000-000000000002', ${issuedAtSql}, ${issuedAtSql}, 1
        );

        INSERT INTO inventory_movements (
          id, store_id, product_id, accounting_period_id, movement_type,
          quantity_before_milli, quantity_delta_milli, quantity_after_milli,
          inventory_value_before_minor, value_delta_minor, inventory_value_after_minor,
          average_unit_cost_after_minor, cost_status, has_pending_cost_after,
          reference_type, reference_id, transaction_group_id, occurred_at,
          device_id, operation_id, created_at
        ) VALUES (
          '40000000-0000-4000-8000-000000000003', '${ids.store}', '${ids.product}',
          '${ids.period}', 'adjustment_in', 0, ${exactQuantitySql}, ${exactQuantitySql},
          0, 0, 0, 0, 'pending', 1, 'manual_inventory',
          '40000000-0000-4000-8000-000000000004',
          '40000000-0000-4000-8000-000000000005', ${issuedAtSql}, '${ids.device}',
          '40000000-0000-4000-8000-000000000006', ${issuedAtSql}
        );

        INSERT INTO manual_inventory_entries (
          id, store_id, operation_id, product_id, product_unit_id,
          selected_quantity_milli, base_quantity_milli, factor_num, factor_den,
          total_purchase_cost_minor, cost_status, occurred_at, business_date,
          posting_date, accounting_period_id, movement_id, transaction_group_id,
          reason, device_id, created_at
        ) VALUES (
          '40000000-0000-4000-8000-000000000004', '${ids.store}',
          '40000000-0000-4000-8000-000000000005', '${ids.product}',
          '${ids.productUnit}', ${exactQuantitySql}, ${exactQuantitySql}, 1, 1, NULL,
          'pending', ${issuedAtSql},
          '2025-10-09', '2025-10-09', '${ids.period}',
          '40000000-0000-4000-8000-000000000003',
          '40000000-0000-4000-8000-000000000005', 'opening stock',
          '${ids.device}', ${issuedAtSql}
        );

        INSERT INTO inventory_movements (
          id, store_id, product_id, accounting_period_id, movement_type,
          quantity_before_milli, quantity_delta_milli, quantity_after_milli,
          inventory_value_before_minor, value_delta_minor, inventory_value_after_minor,
          average_unit_cost_after_minor, cost_status, has_pending_cost_after,
          reference_type, reference_id, transaction_group_id, occurred_at,
          reversal_of_id, reason, device_id, operation_id, created_at
        ) VALUES (
          '40000000-0000-4000-8000-000000000007', '${ids.store}', '${ids.product}',
          '${ids.period}', 'correction', ${exactQuantitySql}, -${exactQuantitySql}, 0,
          0, 0, 0, 0, 'pending', 0, 'inventory_correction',
          '40000000-0000-4000-8000-000000000008',
          '40000000-0000-4000-8000-000000000008', ${issuedAtPlusOneSql},
          '40000000-0000-4000-8000-000000000003', 'correction', '${ids.device}',
          '40000000-0000-4000-8000-000000000009', ${issuedAtPlusOneSql}
        );

        INSERT INTO stock_counts (
          id, store_id, display_number, count_type, started_at, status,
          device_id, operation_id, created_at, updated_at, version
        ) VALUES (
          '40000000-0000-4000-8000-000000000010', '${ids.store}', 'COUNT-1',
          'partial', ${issuedAtSql}, 'draft', '${ids.device}',
          '40000000-0000-4000-8000-000000000011', ${issuedAtSql}, ${issuedAtSql}, 1
        );
      `);

      expect(
        database
          .prepare(
            `select id, movement_id as "movementId", business_date as "businessDate",
                    posting_date as "postingDate"
             from manual_inventory_entries`,
          )
          .get(),
      ).toEqual({
        id: '40000000-0000-4000-8000-000000000004',
        movementId: '40000000-0000-4000-8000-000000000003',
        businessDate: '2025-10-09',
        postingDate: '2025-10-09',
      });
      expect(
        bigintValue(
          database.prepare(
            `select selected_quantity_milli as value from manual_inventory_entries
             where id = ?`,
          ),
          '40000000-0000-4000-8000-000000000004',
        ),
      ).toBe(exactQuantity);
      expect(
        database
          .prepare(
            `select reversal_of_id as value from inventory_movements
             where id = '40000000-0000-4000-8000-000000000007'`,
          )
          .get(),
      ).toEqual({ value: '40000000-0000-4000-8000-000000000003' });
      expect(
        database
          .prepare(
            `select id as value from stock_counts
             where id = '40000000-0000-4000-8000-000000000010'`,
          )
          .get(),
      ).toEqual({ value: '40000000-0000-4000-8000-000000000010' });
      expect(objectSql(database, 'index', 'uq_inventory_movement_reversal')).toMatch(
        /WHERE reversal_of_id IS NOT NULL/i,
      );
      expect(
        tableColumns(database, 'manual_inventory_entries').map((column) => column.name),
      ).not.toEqual(expect.arrayContaining(['correction_status', 'corrected_by_operation_id']));
    } finally {
      database.close();
    }
  });

  it('represents Opening Receivable targets and Customer Credit liability separately', () => {
    const database = createCurrentDatabase();
    const exactAmount = 9_007_199_254_740_993n;
    try {
      seedCoreData(database);
      database
        .prepare(
          `INSERT INTO customer_ledger_entries (
            id, store_id, customer_id, accounting_period_id, entry_type,
            receivable_delta_minor, credit_delta_minor, source_sale_id,
            reference_type, reference_id, transaction_group_id, occurred_at,
            device_id, operation_id, created_at
          ) VALUES (?, ?, ?, ?, 'opening_balance', ?, 0, NULL,
            'customer_opening_receivable', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '50000000-0000-4000-8000-000000000001',
          ids.store,
          ids.customer,
          ids.period,
          exactAmount,
          '50000000-0000-4000-8000-000000000001',
          '50000000-0000-4000-8000-000000000002',
          issuedAt,
          ids.device,
          '50000000-0000-4000-8000-000000000003',
          issuedAt,
        );
      database
        .prepare(
          `INSERT INTO customer_payments (
            id, store_id, customer_id, money_account_id, amount_minor, payment_at,
            status, device_id, operation_id, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 1)`,
        )
        .run(
          '50000000-0000-4000-8000-000000000004',
          ids.store,
          ids.customer,
          ids.moneyAccount,
          exactAmount,
          issuedAt,
          ids.device,
          '50000000-0000-4000-8000-000000000005',
          issuedAt,
          issuedAt,
        );
      database
        .prepare(
          `INSERT INTO customer_payment_allocations (
            id, store_id, customer_payment_id, opening_receivable_ledger_entry_id,
            amount_minor, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '50000000-0000-4000-8000-000000000006',
          ids.store,
          '50000000-0000-4000-8000-000000000004',
          '50000000-0000-4000-8000-000000000001',
          exactAmount,
          issuedAt,
        );

      expect(
        bigintValue(
          database.prepare(
            `select amount_minor as value from customer_payment_allocations
             where id = ?`,
          ),
          '50000000-0000-4000-8000-000000000006',
        ),
      ).toBe(exactAmount);
      expect(
        database
          .prepare(
            `select sale_id as "saleId",
                    opening_receivable_ledger_entry_id as "openingId"
             from customer_payment_allocations
             where id = '50000000-0000-4000-8000-000000000006'`,
          )
          .get(),
      ).toEqual({
        saleId: null,
        openingId: '50000000-0000-4000-8000-000000000001',
      });

      database
        .prepare(
          `INSERT INTO customer_ledger_entries (
            id, store_id, customer_id, accounting_period_id, entry_type,
            receivable_delta_minor, credit_delta_minor, source_sale_id,
            reference_type, reference_id, transaction_group_id, occurred_at,
            device_id, operation_id, created_at
          ) VALUES (?, ?, ?, ?, 'credit_used', 0, ?, ?, 'sale', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '50000000-0000-4000-8000-000000000007',
          ids.store,
          ids.customer,
          ids.period,
          -exactAmount,
          ids.sale,
          ids.sale,
          '50000000-0000-4000-8000-000000000008',
          issuedAt,
          ids.device,
          '50000000-0000-4000-8000-000000000009',
          issuedAt,
        );
      database
        .prepare(
          `INSERT INTO sale_customer_credit_applications (
            id, store_id, sale_id, customer_id, customer_ledger_entry_id,
            amount_minor, applied_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '50000000-0000-4000-8000-000000000010',
          ids.store,
          ids.sale,
          ids.customer,
          '50000000-0000-4000-8000-000000000007',
          exactAmount,
          issuedAt,
          issuedAt,
        );

      expect(
        bigintValue(
          database.prepare(
            `select amount_minor as value from sale_customer_credit_applications
             where id = ?`,
          ),
          '50000000-0000-4000-8000-000000000010',
        ),
      ).toBe(exactAmount);
      const liabilityStatement = database.prepare(
        `select receivable_delta_minor as "receivableDelta",
                credit_delta_minor as "creditDelta"
         from customer_ledger_entries
         where id = '50000000-0000-4000-8000-000000000007'`,
      );
      liabilityStatement.setReadBigInts(true);
      expect(liabilityStatement.get()).toEqual({
        receivableDelta: 0n,
        creditDelta: -exactAmount,
      });
      expect(() =>
        database
          .prepare(
            `update sale_customer_credit_applications set amount_minor = 1
             where id = '50000000-0000-4000-8000-000000000010'`,
          )
          .run(),
      ).toThrow('SALE_CUSTOMER_CREDIT_APPLICATION_IMMUTABLE');
    } finally {
      database.close();
    }
  });

  it('stores only public License verification material and durable trusted-time evidence', () => {
    const database = createCurrentDatabase();
    try {
      seedCoreData(database);
      insertVerifiedLicense(database);
      database.exec(`
        INSERT INTO offline_trusted_time_state (
          store_id, device_id, license_id, state_version, last_trusted_server_at,
          last_seen_device_time, last_trusted_local_sequence,
          clock_rollback_suspected, online_revalidation_required,
          observed_store_status, observed_store_status_at, updated_at
        ) VALUES (
          '${ids.store}', '${ids.device}', '${ids.license}', 1, ${issuedAtSql},
          ${issuedAtSql}, 4, 0, 0, 'active', ${issuedAtSql}, ${issuedAtSql}
        );
      `);

      expect(
        database
          .prepare(
            `select license_version as "licenseVersion", subscription_id as "subscriptionId",
                    subscription_version as "subscriptionVersion",
                    central_entitlement_end as "centralEntitlementEnd",
                    signing_key_id as "signingKeyId", issued_at as "issuedAt",
                    expires_at as "offlineValidUntil", verification_state as "verificationState"
             from local_license where id = '${ids.license}'`,
          )
          .get(),
      ).toEqual({
        licenseVersion: 1,
        subscriptionId: '20000000-0000-4000-8000-000000000001',
        subscriptionVersion: '7',
        centralEntitlementEnd: entitlementEnd,
        signingKeyId: 'offline-key-v1',
        issuedAt,
        offlineValidUntil,
        verificationState: 'verified',
      });
      expect(
        database
          .prepare(
            `select clock_rollback_suspected as "rollbackSuspected",
                    online_revalidation_required as "revalidationRequired",
                    last_trusted_local_sequence as "localSequence"
             from offline_trusted_time_state
             where store_id = '${ids.store}' and device_id = '${ids.device}'`,
          )
          .get(),
      ).toEqual({ rollbackSuspected: 0, revalidationRequired: 0, localSequence: 4 });

      const persistedColumns = [
        ...tableColumns(database, 'local_license'),
        ...tableColumns(database, 'offline_license_verification_keys'),
      ].map((column) => column.name);
      expect(persistedColumns).not.toEqual(
        expect.arrayContaining([
          'private_key',
          'private_key_pkcs8',
          'signing_private_key',
          'secret',
        ]),
      );
      expect(
        tableColumns(database, 'offline_license_verification_keys').map((c) => c.name),
      ).toContain('public_key_spki');

      database.exec(`
        INSERT INTO devices (
          id, store_id, device_name, platform, installation_id, device_prefix,
          status, created_at, updated_at, version
        ) VALUES (
          '${ids.otherDevice}', '${ids.store}', 'Other Device', 'android',
          'install-other', 'P02', 'active', ${issuedAtSql}, ${issuedAtSql}, 1
        );
      `);
      expect(() =>
        database.exec(`
          INSERT INTO offline_trusted_time_state (
            store_id, device_id, license_id, updated_at
          ) VALUES ('${ids.store}', '${ids.otherDevice}', '${ids.license}', ${issuedAtSql});
        `),
      ).toThrow(/FOREIGN KEY constraint failed/i);
      expect(() =>
        database.exec(`
          UPDATE offline_trusted_time_state
          SET clock_rollback_suspected = 1, online_revalidation_required = 0
          WHERE store_id = '${ids.store}' AND device_id = '${ids.device}';
        `),
      ).toThrow(/CHECK constraint failed/i);
    } finally {
      database.close();
    }
  });

  it('enforces the v1 outbox envelope, sequence, dependencies, and result vocabulary', () => {
    const database = createCurrentDatabase();
    const losslessSequence = 9_007_199_254_740_993n;
    try {
      seedCoreData(database);
      insertVerifiedLicense(database);
      const operationIds = Array.from(
        { length: 8 },
        (_, index) => `60000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
      );
      for (const [index, operationId] of operationIds.entries()) {
        insertOutboxOperation(database, operationId, index + 1);
      }

      const firstOperation = operationIds[0];
      const secondOperation = operationIds[1];
      if (!firstOperation || !secondOperation) {
        throw new Error('The outbox fixture operation IDs are unavailable.');
      }
      database
        .prepare(
          `INSERT INTO sync_outbox_dependencies (
            store_id, operation_id, depends_on_operation_id, dependency_order, created_at
          ) VALUES (?, ?, ?, 0, ?)`,
        )
        .run(ids.store, secondOperation, firstOperation, issuedAt);
      database
        .prepare(
          `INSERT INTO sync_local_sequence_state (
            store_id, device_id, last_allocated_sequence, next_sequence, updated_at
          ) VALUES (?, ?, 0, 1, ?)`,
        )
        .run(ids.store, ids.device, issuedAt);
      database
        .prepare(
          `update sync_local_sequence_state
           set last_allocated_sequence = 8, next_sequence = 9, updated_at = ?
           where store_id = ? and device_id = ?`,
        )
        .run(issuedAt, ids.store, ids.device);
      insertOutboxOperation(database, '60000000-0000-4000-8000-000000000099', losslessSequence);
      database
        .prepare(
          `update sync_local_sequence_state
           set last_allocated_sequence = ?, next_sequence = ?, updated_at = ?
           where store_id = ? and device_id = ?`,
        )
        .run(losslessSequence, losslessSequence + 1n, issuedAt + 1, ids.store, ids.device);

      const classifications = [
        'APPLIED',
        'EXACT_REPLAY',
        'REJECTED',
        'DEPENDENCY_PENDING',
        'CONFLICT',
        'QUARANTINED',
      ] as const;
      for (const [index, classification] of classifications.entries()) {
        const operationId = operationIds[index];
        if (!operationId) {
          throw new Error('The result fixture operation ID is unavailable.');
        }
        database
          .prepare(
            `INSERT INTO sync_operation_results (
              id, store_id, device_id, operation_id, classification, domain_code,
              response_json, recovery_json, server_recorded_at, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `70000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
            ids.store,
            ids.device,
            operationId,
            classification,
            classification === 'APPLIED' ? null : 'SYNC_RESULT',
            JSON.stringify(
              classification === 'APPLIED'
                ? {
                    originalEntryId: 'inventory-original',
                    reversalMovementId: 'inventory-reversal',
                    replacementEntryId: 'inventory-replacement',
                  }
                : { classification },
            ),
            classification === 'DEPENDENCY_PENDING'
              ? JSON.stringify({ retryAfterDependency: firstOperation })
              : null,
            issuedAt,
            issuedAt,
          );
      }

      expect(
        database
          .prepare('select classification from sync_operation_results order by classification')
          .all(),
      ).toEqual([...classifications].sort().map((classification) => ({ classification })));
      expect(
        database
          .prepare(
            `select depends_on_operation_id as value from sync_outbox_dependencies
             where operation_id = ?`,
          )
          .get(secondOperation),
      ).toEqual({ value: firstOperation });
      expect(
        bigintValue(
          database.prepare(
            `select local_sequence as value from sync_outbox
             where operation_id = ?`,
          ),
          '60000000-0000-4000-8000-000000000099',
        ),
      ).toBe(losslessSequence);
      expect(() =>
        database
          .prepare(
            `update sync_local_sequence_state
             set last_allocated_sequence = 8, next_sequence = 9
             where store_id = ? and device_id = ?`,
          )
          .run(ids.store, ids.device),
      ).toThrow('SYNC_LOCAL_SEQUENCE_CANNOT_MOVE_BACKWARD_OR_REPEAT');
      expect(() =>
        database
          .prepare('delete from sync_local_sequence_state where store_id = ? and device_id = ?')
          .run(ids.store, ids.device),
      ).toThrow('SYNC_LOCAL_SEQUENCE_CANNOT_BE_DELETED');
      expect(() => insertOutboxOperation(database, firstOperation, 9)).toThrow(
        /UNIQUE constraint failed/i,
      );
      expect(() =>
        insertOutboxOperation(database, '60000000-0000-4000-8000-000000000100', 1),
      ).toThrow(/UNIQUE constraint failed/i);
      expect(() =>
        database
          .prepare('update sync_outbox set payload_json = ? where operation_id = ?')
          .run('{"changed":true}', firstOperation),
      ).toThrow('SYNC_OUTBOX_ENVELOPE_IS_IMMUTABLE');
      expect(() =>
        database.exec(`
          INSERT INTO sync_outbox (
            id, store_id, device_id, operation_id, contract_state, payload_json,
            created_at, updated_at
          ) VALUES (
            '60000000-0000-4000-8000-000000000200', '${ids.store}', '${ids.device}',
            '60000000-0000-4000-8000-000000000201', 'legacy_unclassified', '{}',
            ${issuedAtSql}, ${issuedAtSql}
          );
        `),
      ).toThrow('NEW_SYNC_OUTBOX_OPERATION_REQUIRES_V1_ENVELOPE');

      const outboxColumns = tableColumns(database, 'sync_outbox').map((column) => column.name);
      expect(outboxColumns).toEqual(
        expect.arrayContaining([
          'protocol_version',
          'operation_type',
          'operation_id',
          'client_recorded_at',
          'offline_license_id',
          'signed_license_json',
          'trusted_time_evidence_json',
          'local_sequence',
        ]),
      );
      expect(
        outboxColumns.some((name) => /balance|authoritative_total|authoritative_cost/.test(name)),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it('persists crash-safe cursor receipts and distinguishes staging from active datasets', () => {
    const database = createCurrentDatabase();
    try {
      seedCoreData(database);
      database.exec(`
        INSERT INTO sync_state (
          store_id, device_id, protocol_version, change_feed_version,
          last_safe_cursor, active_dataset_id, bootstrap_generation_id,
          cursor_application_status, pending_count
        ) VALUES (
          '${ids.store}', '${ids.device}', 1, 1, 'cursor-10',
          'dataset-active', 'bootstrap-1', 'ready', 0
        );

        INSERT INTO sync_inbox_receipts (
          id, store_id, contract_state, protocol_version, change_feed_version,
          cursor, server_event_id, entity_type, entity_id, server_version,
          bootstrap_generation_id, payload_hash, application_status,
          received_at, applied_at
        ) VALUES (
          '80000000-0000-4000-8000-000000000001', '${ids.store}', 'v1', 1, 1,
          'cursor-11', '80000000-0000-4000-8000-000000000002', 'customer',
          '${ids.customer}', 2, 'bootstrap-1', 'sha256:payload', 'applied',
          ${issuedAtSql}, ${issuedAtSql}
        );

        INSERT INTO local_dataset_state (
          singleton_id, store_id, device_id, dataset_id, bootstrap_generation_id,
          snapshot_id, protocol_version, change_feed_version, dataset_status, started_at
        ) VALUES (
          1, '${ids.store}', '${ids.device}', 'dataset-staging', 'bootstrap-2',
          'snapshot-2', 1, 1, 'staging', ${issuedAtSql}
        );
      `);

      expect(
        database
          .prepare('select dataset_status as value from local_dataset_state where singleton_id = 1')
          .get(),
      ).toEqual({ value: 'staging' });
      expect(() =>
        database.exec(`
          UPDATE local_dataset_state
          SET dataset_status = 'active', safe_base_cursor = 'cursor-20'
          WHERE singleton_id = 1;
        `),
      ).toThrow(/CHECK constraint failed/i);
      database.exec(`
        UPDATE local_dataset_state
        SET dataset_status = 'validated', validated_at = ${issuedAtPlusOneSql},
            checksum_manifest_json = '{"customers":"sha256:fixture"}'
        WHERE singleton_id = 1;

        UPDATE local_dataset_state
        SET dataset_status = 'active', activated_at = ${issuedAtPlusTwoSql},
            safe_base_cursor = 'cursor-20'
        WHERE singleton_id = 1;
      `);
      expect(
        database
          .prepare(
            `select dataset_status as status, safe_base_cursor as cursor,
                    validated_at as "validatedAt", activated_at as "activatedAt"
             from local_dataset_state where singleton_id = 1`,
          )
          .get(),
      ).toEqual({
        status: 'active',
        cursor: 'cursor-20',
        validatedAt: issuedAt + 1,
        activatedAt: issuedAt + 2,
      });
      expect(() =>
        database.exec(`
          INSERT INTO sync_inbox_receipts (
            id, store_id, contract_state, protocol_version, change_feed_version,
            cursor, server_event_id, entity_type, entity_id, application_status,
            received_at
          ) VALUES (
            '80000000-0000-4000-8000-000000000003', '${ids.store}', 'v1', 1, 1,
            'cursor-11', '80000000-0000-4000-8000-000000000004', 'customer',
            '${ids.customer}', 'received', ${issuedAtSql}
          );
        `),
      ).toThrow(/UNIQUE constraint failed/i);
      expect(database.prepare('pragma foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
