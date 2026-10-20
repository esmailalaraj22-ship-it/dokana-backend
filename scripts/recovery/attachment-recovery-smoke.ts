import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';

import { ATTACHMENT_MAX_BYTES } from '../../src/attachments/attachment.types';
import { ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES } from '../../src/recovery/attachment-recovery-manifest';
import { AttachmentRecoveryCatalogService } from '../../src/recovery/attachment-recovery-catalog.service';
import type { RecoveryArtifactStoragePort } from '../../src/recovery/recovery-artifact-storage.port';
import { RecoveryCatalogService } from '../../src/recovery/recovery-catalog.service';
import { sha256 } from '../../src/recovery/recovery-manifest';
import { readAttachmentRecoveryEntries } from './attachment-recovery-files';
import { sha256File } from './recovery-point-job';

interface RestoredAttachmentRow {
  mediaType: string | null;
  sizeBytes: string | null;
  sha256: string | null;
  removed: boolean;
}

export async function verifyIsolatedAttachmentRecovery(input: {
  pool: Pool;
  storage: RecoveryArtifactStoragePort;
  recoveryPointId: string;
}): Promise<void> {
  const databaseCatalog = new RecoveryCatalogService(input.storage);
  const attachmentCatalog = new AttachmentRecoveryCatalogService(input.storage, databaseCatalog);
  const manifest = await attachmentCatalog.readVerifiedManifest(input.recoveryPointId);
  if (!manifest) throw new Error('Attachment recovery manifest is unavailable for restore smoke.');

  const directory = await mkdtemp(join(tmpdir(), 'dokana-attachment-restore-smoke-'));
  await chmod(directory, 0o700);
  try {
    const entriesPath = join(directory, 'entries.ndjson');
    const downloaded = await input.storage.downloadToFile(
      manifest.entries.key,
      entriesPath,
      ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
    );
    if (!downloaded || (await sha256File(entriesPath)) !== manifest.entries.sha256) {
      throw new Error('Attachment recovery entries failed restore-smoke integrity verification.');
    }

    let entryCount = 0;
    for await (const entry of readAttachmentRecoveryEntries(entriesPath, input.recoveryPointId)) {
      const metadata = await input.pool.query<RestoredAttachmentRow>(
        `
          select
            mime_type as "mediaType",
            file_size_bytes::text as "sizeBytes",
            checksum_sha256 as sha256,
            removed_at is not null as removed
          from ledger.attachments
          where id = $1
        `,
        [entry.attachmentId],
      );
      const row = metadata.rows[0];
      if (
        metadata.rowCount !== 1 ||
        !row ||
        row.removed ||
        row.mediaType !== entry.mediaType ||
        row.sizeBytes !== entry.sizeBytes ||
        row.sha256 !== entry.sha256
      ) {
        throw new Error('Protected attachment does not map to active restored metadata.');
      }
      const object = await input.storage.readBuffer(entry.protectedObjectKey, ATTACHMENT_MAX_BYTES);
      if (object?.byteLength !== Number(entry.sizeBytes) || sha256(object) !== entry.sha256) {
        throw new Error('Protected attachment failed isolated reconstruction verification.');
      }
      const reconstructed = join(directory, `${entry.attachmentId}.bin`);
      await writeFile(reconstructed, object, { flag: 'wx', mode: 0o600 });
      if ((await sha256File(reconstructed)) !== entry.sha256) {
        throw new Error('Reconstructed attachment failed isolated integrity verification.');
      }
      entryCount += 1;
    }
    const active = await input.pool.query<{ count: number }>(`
      select count(*)::integer as count
      from ledger.attachments
      where removed_at is null
    `);
    if (active.rows[0]?.count !== entryCount || manifest.attachmentEntryCount !== entryCount) {
      throw new Error(
        'Attachment recovery entries do not cover the restored active attachment set.',
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
