import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { isUuid } from '../common/logging/request-id';
import { AppConfigService } from '../config/app-config.service';

const cursorPrefix = 'sc1';
const maximumCursorLength = 512;
const maximumSequence = 9_223_372_036_854_775_807n;

export interface SyncCursorPosition {
  storeId: string;
  sequence: bigint;
}

export class InvalidSyncCursorError extends Error {
  constructor() {
    super('The synchronization cursor is invalid.');
    this.name = 'InvalidSyncCursorError';
  }
}

export class LegacySyncCursorError extends Error {
  constructor() {
    super('The synchronization cursor predates the replayable stream.');
    this.name = 'LegacySyncCursorError';
  }
}

function parseSequence(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new InvalidSyncCursorError();
  const sequence = BigInt(value);
  if (sequence > maximumSequence) throw new InvalidSyncCursorError();
  return sequence;
}

@Injectable()
export class SyncCursorService {
  private readonly activeKeyId: string;
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(config: AppConfigService) {
    const tokenConfig = config.authenticationTokens;
    this.activeKeyId = tokenConfig.activeKeyId;
    this.keys = new Map([
      [tokenConfig.activeKeyId, Buffer.from(tokenConfig.activeSecret, 'base64url')],
      ...Object.entries(tokenConfig.previousSecrets).map(
        ([keyId, secret]) => [keyId, Buffer.from(secret, 'base64url')] as const,
      ),
    ]);
  }

  issue(storeId: string, sequenceValue: string | bigint): string {
    const normalizedStoreId = storeId.toLowerCase();
    if (!isUuid(normalizedStoreId)) throw new InvalidSyncCursorError();
    const sequence = parseSequence(sequenceValue.toString());
    const encodedKeyId = Buffer.from(this.activeKeyId, 'utf8').toString('base64url');
    const unsigned = `${cursorPrefix}.${encodedKeyId}.${normalizedStoreId}.${sequence.toString()}`;
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new Error('The active synchronization cursor key is unavailable.');
    return `${unsigned}.${this.signature(unsigned, key)}`;
  }

  decode(value: string): SyncCursorPosition {
    if (/^(0|[1-9][0-9]*)$/.test(value)) throw new LegacySyncCursorError();
    if (value.length < 64 || value.length > maximumCursorLength) {
      throw new InvalidSyncCursorError();
    }
    const parts = value.split('.');
    if (parts.length !== 5 || parts[0] !== cursorPrefix) throw new InvalidSyncCursorError();
    const [, encodedKeyId, storeId, sequenceValue, signature] = parts;
    if (!encodedKeyId || !storeId || !sequenceValue || !signature || !isUuid(storeId)) {
      throw new InvalidSyncCursorError();
    }

    let keyId: string;
    try {
      keyId = Buffer.from(encodedKeyId, 'base64url').toString('utf8');
    } catch {
      throw new InvalidSyncCursorError();
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new InvalidSyncCursorError();
    const key = this.keys.get(keyId);
    if (!key) throw new LegacySyncCursorError();

    const unsigned = `${cursorPrefix}.${encodedKeyId}.${storeId}.${sequenceValue}`;
    if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new InvalidSyncCursorError();
    const expected = Buffer.from(this.signature(unsigned, key), 'ascii');
    const actual = Buffer.from(signature, 'ascii');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new InvalidSyncCursorError();
    }

    return { storeId: storeId.toLowerCase(), sequence: parseSequence(sequenceValue) };
  }

  private signature(unsigned: string, key: Buffer): string {
    return createHmac('sha256', key).update(unsigned, 'utf8').digest('base64url');
  }
}
