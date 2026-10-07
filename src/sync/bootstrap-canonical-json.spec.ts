import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BootstrapArtifactIntegrityError,
  BootstrapArtifactNotFoundError,
  BootstrapArtifactStore,
} from './bootstrap-artifact.store';
import { bootstrapChecksum, canonicalBootstrapJson } from './bootstrap-canonical-json';
import type { BootstrapManifestCore } from './bootstrap.types';

describe('bootstrap canonical integrity and artifacts', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dokana-bootstrap-unit-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('canonicalizes object key order and preserves exact decimal strings', () => {
    const left = { amount: '9007199254740993', nested: { b: true, a: '1250' } };
    const right = { nested: { a: '1250', b: true }, amount: '9007199254740993' };
    expect(canonicalBootstrapJson(left)).toBe(canonicalBootstrapJson(right));
    expect(bootstrapChecksum(left)).toBe(bootstrapChecksum(right));
  });

  it('publishes only complete immutable artifacts and detects page corruption', async () => {
    const store = new BootstrapArtifactStore(root);
    const sessionId = '19040000-0000-4000-8000-000000000001';
    const writer = await store.begin(sessionId);
    await expect(store.readManifest(sessionId)).rejects.toBeInstanceOf(
      BootstrapArtifactNotFoundError,
    );

    const page = await writer.writePage({
      bootstrapVersion: 1,
      sessionId,
      snapshotId: 'a'.repeat(64),
      datasetId: 'customers',
      pageNumber: 1,
      recordCount: 1,
      records: [{ id: '19040000-0000-4000-8000-000000000002', balance_minor: '9' }],
    });
    const manifestCore: BootstrapManifestCore = {
      bootstrapVersion: 1,
      protocolVersion: 1,
      changeFeedVersion: 1,
      sqliteSchemaVersion: 10_300,
      sessionId,
      datasetId: sessionId,
      bootstrapGenerationId: sessionId,
      storeId: '19040000-0000-4000-8000-000000000003',
      deviceId: '19040000-0000-4000-8000-000000000004',
      status: 'ready',
      serverTime: '2026-10-06T00:00:00.000Z',
      expiresAt: '2099-10-06T00:00:00.000Z',
      snapshotId: 'a'.repeat(64),
      baseCursor: '41',
      pageSize: 100,
      encoding: {
        bigInteger: 'decimal_string',
        quantity: 'integer_milli_units_as_decimal_string',
        money: 'integer_minor_units_as_decimal_string',
        timestamp: 'rfc3339_utc',
      },
      activationContract: {
        stagingModel: 'separate_sqlite_database',
        validation: ['page_checksums', 'dataset_checksums', 'manifest_checksum', 'foreign_keys'],
        activation: 'atomic_database_swap_with_base_cursor',
        incompleteBootstrap: 'must_not_activate',
      },
      datasets: [
        {
          id: 'customers',
          order: 1,
          recordCount: 1,
          pageCount: 1,
          checksum: bootstrapChecksum(page.checksum),
        },
      ],
    };
    await writer.finalize(manifestCore);
    const manifest = await store.readManifest(sessionId);
    expect(await store.readPage(manifest, 'customers', 1)).toEqual(page);
    expect(await store.readPage(manifest, 'customers', 1)).toEqual(page);

    const pagePath = join(root, sessionId, 'customers.00000001.json');
    const corrupted = JSON.parse(await readFile(pagePath, 'utf8')) as {
      records: Record<string, unknown>[];
    };
    if (corrupted.records[0]) corrupted.records[0].balance_minor = '1';
    await writeFile(pagePath, JSON.stringify(corrupted), 'utf8');
    await expect(store.readPage(manifest, 'customers', 1)).rejects.toBeInstanceOf(
      BootstrapArtifactIntegrityError,
    );
  });
});
