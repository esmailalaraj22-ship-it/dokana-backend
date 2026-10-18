import { getTableConfig } from 'drizzle-orm/pg-core';

import { attachments } from '../database/schema';

const tableConfig = getTableConfig(attachments);

describe('attachments Drizzle mapping', () => {
  it('maps the ledger.attachments identity and physical columns exactly', () => {
    expect({ schema: tableConfig.schema, table: tableConfig.name }).toEqual({
      schema: 'ledger',
      table: 'attachments',
    });
    expect(tableConfig.columns.map((column) => column.name)).toEqual([
      'id',
      'store_id',
      'entity_type',
      'entity_id',
      'kind',
      'file_name',
      'mime_type',
      'local_uri',
      'remote_key',
      'file_size_bytes',
      'checksum_sha256',
      'sync_status',
      'created_at',
      'updated_at',
      'removed_at',
      'removed_by_user_id',
    ]);
  });

  it('preserves UUID, bigint, timestamp, and lifecycle nullability semantics', () => {
    expect(attachments.id.primary).toBe(true);
    expect(attachments.storeId.notNull).toBe(true);
    expect(attachments.fileSizeBytes.dataType).toBe('bigint');
    expect(attachments.createdAt.dataType).toBe('date');
    expect(attachments.createdAt.notNull).toBe(true);
    expect(attachments.removedAt.notNull).toBe(false);
    expect(attachments.removedByUserId.notNull).toBe(false);
  });

  it('maps the tenant and removal-actor foreign keys with exact semantics', () => {
    const foreignKeys = new Map(
      tableConfig.foreignKeys.map((foreignKey) => [foreignKey.getName(), foreignKey]),
    );
    const store = foreignKeys.get('attachments_store_id_fkey');
    const actor = foreignKeys.get('attachments_removed_by_user_id_fkey');
    if (!store || !actor) throw new Error('Expected both attachment foreign keys.');

    expect(getTableConfig(store.reference().foreignTable)).toMatchObject({
      schema: 'ledger',
      name: 'stores',
    });
    expect(store.onUpdate).toBe('cascade');
    expect(store.onDelete).toBe('cascade');
    expect(getTableConfig(actor.reference().foreignTable)).toMatchObject({
      schema: 'platform',
      name: 'users',
    });
    expect(actor.onUpdate).toBe('cascade');
    expect(actor.onDelete).toBe('restrict');
  });

  it('maps every approved check, uniqueness rule, and active-parent index', () => {
    expect(tableConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      'attachments_file_name_check',
      'attachments_file_size_bytes_check',
      'attachments_kind_check',
      'attachments_removal_evidence_check',
      'attachments_sync_status_check',
    ]);
    expect(tableConfig.uniqueConstraints.map((constraint) => constraint.name)).toEqual([
      'attachments_store_id_id_key',
    ]);
    expect(tableConfig.indexes.map((index) => index.config.name)).toEqual([
      'idx_attachments_active_entity',
    ]);
    expect(tableConfig.indexes[0]?.config.where).toBeDefined();
  });
});
