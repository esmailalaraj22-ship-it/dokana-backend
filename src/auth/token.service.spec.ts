import { randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';

import type { AppConfigService } from '../config/app-config.service';
import { InvalidAccessTokenError, TokenService } from './token.service';

const activeSecret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const previousSecret = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const activeKey = Uint8Array.from(Buffer.from(activeSecret, 'base64url'));
const previousKey = Uint8Array.from(Buffer.from(previousSecret, 'base64url'));

const tokenConfiguration = {
  issuer: 'dokana-test',
  audience: 'dokana-test-client',
  activeKeyId: 'active-v2',
  activeSecret,
  previousSecrets: {
    'previous-v1': previousSecret,
  },
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  sessionTtlSeconds: 2_592_000,
};

const principal = {
  userId: randomUUID(),
  sessionId: randomUUID(),
  storeId: randomUUID(),
  deviceId: randomUUID(),
};

function createService(): TokenService {
  return new TokenService({
    authenticationTokens: tokenConfiguration,
  } as unknown as AppConfigService);
}

async function customToken(options?: {
  key?: Uint8Array;
  keyId?: string;
  issuer?: string;
  audience?: string;
  tokenType?: string;
  expiresAt?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);

  return new SignJWT({
    typ: options?.tokenType ?? 'access',
    sid: principal.sessionId,
    store_id: principal.storeId,
    device_id: principal.deviceId,
  })
    .setProtectedHeader({
      alg: 'HS256',
      kid: options?.keyId ?? 'active-v2',
      typ: 'JWT',
    })
    .setSubject(principal.userId)
    .setJti(randomUUID())
    .setIssuer(options?.issuer ?? tokenConfiguration.issuer)
    .setAudience(options?.audience ?? tokenConfiguration.audience)
    .setIssuedAt(now)
    .setExpirationTime(options?.expiresAt ?? now + 900)
    .sign(options?.key ?? activeKey);
}

describe('TokenService', () => {
  it('issues and verifies a valid HS256 access token', async () => {
    const service = createService();
    const tokenId = randomUUID();
    const token = await service.issueAccessToken(principal, tokenId);

    await expect(service.verifyAccessToken(token)).resolves.toMatchObject({
      ...principal,
      tokenId,
    });
  });

  it('accepts an explicitly configured previous verification key', async () => {
    const service = createService();
    const token = await customToken({
      key: previousKey,
      keyId: 'previous-v1',
    });

    await expect(service.verifyAccessToken(token)).resolves.toMatchObject(principal);
  });

  it.each([
    ['malformed token', 'not-a-jwt'],
    ['invalid signature', undefined],
  ])('rejects %s', async (_label, tokenOverride) => {
    const service = createService();
    const token =
      tokenOverride ??
      (await customToken({
        key: Uint8Array.from(
          Buffer.from('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 'base64url'),
        ),
      }));

    await expect(service.verifyAccessToken(token)).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it.each([
    ['expired', { expiresAt: Math.floor(Date.now() / 1_000) - 60 }],
    ['wrong issuer', { issuer: 'unexpected-issuer' }],
    ['wrong audience', { audience: 'unexpected-audience' }],
    ['wrong token type', { tokenType: 'refresh' }],
    [
      'unknown signing key',
      {
        keyId: 'unknown-v9',
        key: Uint8Array.from(
          Buffer.from('DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', 'base64url'),
        ),
      },
    ],
  ])('rejects a token with %s', async (_label, options) => {
    const service = createService();
    const token = await customToken(options);

    await expect(service.verifyAccessToken(token)).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });
});
