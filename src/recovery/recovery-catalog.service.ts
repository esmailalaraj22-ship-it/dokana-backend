import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  RECOVERY_ARTIFACT_STORAGE,
  RecoveryStorageConflictError,
  type RecoveryArtifactStoragePort,
} from './recovery-artifact-storage.port';
import {
  RECOVERY_CATALOG_PREFIX,
  RECOVERY_MANIFEST_MAXIMUM_BYTES,
  parseRecoveryManifest,
  recoveryJobLockKey,
  recoveryManifestKey,
  serializeRecoveryManifest,
  sha256,
  type RecoveryManifest,
  type VerifiedRecoveryManifest,
} from './recovery-manifest';

const VERIFIED_MANIFEST_PREFIX = `${RECOVERY_CATALOG_PREFIX}/manifests/verified/`;
const CATALOG_SCAN_LIMIT = 1_000;
const RETENTION_DELETE_LIMIT = 25;

export interface RecoveryCatalogState {
  latestVerified: VerifiedRecoveryManifest | null;
  verifiedCount: number;
  invalidCount: number;
}

@Injectable()
export class RecoveryCatalogService {
  constructor(
    @Inject(RECOVERY_ARTIFACT_STORAGE)
    private readonly storage: RecoveryArtifactStoragePort,
  ) {}

  get configured(): boolean {
    return this.storage.configured;
  }

  async writeManifest(manifest: RecoveryManifest): Promise<void> {
    const body = serializeRecoveryManifest(manifest);
    await this.storage.putBuffer({
      key: recoveryManifestKey(manifest),
      body,
      contentType: 'application/json',
      contentLength: body.byteLength,
      checksumSha256: sha256(body),
    });
  }

  async inspectVerifiedCatalog(): Promise<RecoveryCatalogState> {
    const manifests = await this.readVerifiedManifests();
    const valid: VerifiedRecoveryManifest[] = [];
    let invalidCount = 0;
    for (const manifest of manifests) {
      if (await this.artifactMatches(manifest)) valid.push(manifest);
      else invalidCount += 1;
    }
    valid.sort((left, right) =>
      right.verification.verifiedAt.localeCompare(left.verification.verifiedAt),
    );
    return {
      latestVerified: valid[0] ?? null,
      verifiedCount: valid.length,
      invalidCount,
    };
  }

  async classifyRetention(createdAt: Date): Promise<'DAILY' | 'MONTHLY'> {
    const month = createdAt.toISOString().slice(0, 7);
    const manifests = await this.readVerifiedManifests();
    for (const manifest of manifests) {
      if (
        manifest.retentionClass === 'MONTHLY' &&
        manifest.createdAt.startsWith(month) &&
        (await this.artifactMatches(manifest))
      ) {
        return 'DAILY';
      }
    }
    return 'MONTHLY';
  }

  async acquireJobLock(): Promise<string> {
    const token = randomUUID();
    const body = Buffer.from(
      `${JSON.stringify({ version: 1, token, acquiredAt: new Date().toISOString() })}\n`,
      'utf8',
    );
    try {
      await this.storage.putBuffer({
        key: recoveryJobLockKey(),
        body,
        contentType: 'application/json',
        contentLength: body.byteLength,
        checksumSha256: sha256(body),
      });
      return token;
    } catch (error) {
      if (error instanceof RecoveryStorageConflictError) {
        throw new Error('A recovery-point operation is already active.');
      }
      throw error;
    }
  }

  async releaseJobLock(token: string): Promise<void> {
    const body = await this.storage.readBuffer(recoveryJobLockKey(), 4_096);
    if (!body) return;
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!isMatchingLock(parsed, token)) {
      throw new Error('Recovery-point lock ownership verification failed.');
    }
    await this.storage.deleteObject(recoveryJobLockKey());
  }

  async cleanupExpired(now: Date): Promise<{ deleted: number; retained: number }> {
    const state = await this.inspectVerifiedCatalog();
    const manifests = await this.readVerifiedManifests();
    const valid = manifests
      .filter((manifest) => manifest.recoveryPointId !== state.latestVerified?.recoveryPointId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const deletable = valid
      .filter((manifest) => isRetentionExpired(manifest, now))
      .slice(0, RETENTION_DELETE_LIMIT);
    let deleted = 0;
    for (const manifest of deletable) {
      if (!(await this.artifactMatches(manifest))) continue;
      await this.storage.deleteObject(recoveryManifestKey(manifest));
      await this.storage.deleteObject(manifest.artifact.key);
      deleted += 1;
    }
    return { deleted, retained: manifests.length - deleted };
  }

  private async readVerifiedManifests(): Promise<VerifiedRecoveryManifest[]> {
    const objects = await this.storage.listObjects({
      prefix: VERIFIED_MANIFEST_PREFIX,
      limit: CATALOG_SCAN_LIMIT,
      continuationToken: null,
    });
    if (objects.nextToken !== null) {
      throw new Error('Recovery catalog exceeds the bounded scan limit.');
    }
    const manifests: VerifiedRecoveryManifest[] = [];
    for (const object of objects.objects) {
      try {
        const body = await this.storage.readBuffer(object.key, RECOVERY_MANIFEST_MAXIMUM_BYTES);
        const metadata =
          object.checksumSha256 === null ? await this.storage.headObject(object.key) : object;
        if (!body || metadata?.checksumSha256 !== sha256(body) || metadata.encryption === null) {
          continue;
        }
        const manifest = parseRecoveryManifest(body);
        if (manifest.state === 'VERIFIED' && recoveryManifestKey(manifest) === object.key) {
          manifests.push(manifest);
        }
      } catch {
        continue;
      }
    }
    return manifests;
  }

  private async artifactMatches(manifest: VerifiedRecoveryManifest): Promise<boolean> {
    const artifact = await this.storage.headObject(manifest.artifact.key);
    return (
      artifact?.contentLength === manifest.artifact.sizeBytes &&
      artifact.checksumSha256 === manifest.artifact.sha256 &&
      artifact.encryption !== null
    );
  }
}

function isRetentionExpired(manifest: VerifiedRecoveryManifest, now: Date): boolean {
  const createdAt = new Date(manifest.createdAt).getTime();
  if (manifest.retentionClass === 'DAILY') {
    return now.getTime() - createdAt >= 35 * 24 * 60 * 60 * 1_000;
  }
  const monthlyThreshold = subtractUtcCalendarMonths(now, 12);
  return createdAt <= monthlyThreshold.getTime();
}

function subtractUtcCalendarMonths(value: Date, months: number): Date {
  const target = new Date(value);
  const desiredDay = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(desiredDay, lastDay));
  return target;
}

function isMatchingLock(value: unknown, token: string): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'version' in value &&
    value.version === 1 &&
    'token' in value &&
    value.token === token,
  );
}
