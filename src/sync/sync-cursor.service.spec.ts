import { randomUUID } from 'node:crypto';

import type { AppConfigService, AuthenticationTokenConfig } from '../config/app-config.service';
import {
  InvalidSyncCursorError,
  LegacySyncCursorError,
  SyncCursorService,
} from './sync-cursor.service';

function tokenConfig(
  activeKeyId: string,
  activeByte: number,
  previousSecrets: Readonly<Record<string, string>> = {},
): AuthenticationTokenConfig {
  return {
    issuer: 'test',
    audience: 'test',
    activeKeyId,
    activeSecret: Buffer.alloc(32, activeByte).toString('base64url'),
    previousSecrets,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3_600,
    sessionTtlSeconds: 3_600,
  };
}

function service(config: AuthenticationTokenConfig): SyncCursorService {
  return new SyncCursorService({ authenticationTokens: config } as unknown as AppConfigService);
}

describe('SyncCursorService', () => {
  it('round-trips a Store-bound lossless PostgreSQL sequence deterministically', () => {
    const cursors = service(tokenConfig('test.v1', 1));
    const storeId = randomUUID();
    const cursor = cursors.issue(storeId.toUpperCase(), 9_223_372_036_854_775_807n);

    expect(cursors.issue(storeId, '9223372036854775807')).toBe(cursor);
    expect(cursors.decode(cursor)).toEqual({
      storeId,
      sequence: 9_223_372_036_854_775_807n,
    });
  });

  it('rejects legacy, malformed, tampered, and overflowing cursors', () => {
    const cursors = service(tokenConfig('test-v1', 2));
    const valid = cursors.issue(randomUUID(), 41n);
    const replacement = valid.endsWith('A') ? 'B' : 'A';
    const tampered = `${valid.slice(0, -1)}${replacement}`;

    expect(() => cursors.decode('41')).toThrow(LegacySyncCursorError);
    expect(() => cursors.decode('not-a-cursor')).toThrow(InvalidSyncCursorError);
    expect(() => cursors.decode(tampered)).toThrow(InvalidSyncCursorError);
    expect(() => cursors.issue(randomUUID(), '9223372036854775808')).toThrow(
      InvalidSyncCursorError,
    );
  });

  it('accepts retained signing keys and requires rebootstrap after key retirement', () => {
    const oldSecret = Buffer.alloc(32, 3).toString('base64url');
    const old = service({ ...tokenConfig('old-v1', 3), activeSecret: oldSecret });
    const storeId = randomUUID();
    const cursor = old.issue(storeId, 7n);

    const rotated = service(tokenConfig('new-v2', 4, { 'old-v1': oldSecret }));
    expect(rotated.decode(cursor)).toEqual({ storeId, sequence: 7n });
    expect(() => service(tokenConfig('new-v2', 4)).decode(cursor)).toThrow(LegacySyncCursorError);
  });
});
