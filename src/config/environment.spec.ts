import { generateKeyPairSync } from 'node:crypto';

import { validateEnvironment } from './environment';

const offlineLicenseKeys = generateKeyPairSync('ed25519');
const offlineLicensePrivateKey = offlineLicenseKeys.privateKey
  .export({ format: 'der', type: 'pkcs8' })
  .toString('base64url');
const offlineLicensePublicKey = offlineLicenseKeys.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64url');

const minimumEnvironment = {
  DATABASE_URL: 'postgresql://runtime:password@localhost:5432/dokana',
  AUTH_DATABASE_URL: 'postgresql://auth:password@localhost:5432/dokana',
  DATABASE_SSL_MODE: 'disable',
  AUTH_ACCESS_TOKEN_ACTIVE_KID: 'test-v1',
  AUTH_ACCESS_TOKEN_ACTIVE_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  OFFLINE_LICENSE_ACTIVE_KEY_ID: 'offline-test-v1',
  OFFLINE_LICENSE_ACTIVE_PRIVATE_KEY_PKCS8: offlineLicensePrivateKey,
  OFFLINE_LICENSE_PUBLIC_KEYS: JSON.stringify({
    'offline-test-v1': offlineLicensePublicKey,
  }),
};

describe('validateEnvironment', () => {
  it('applies safe deterministic defaults', () => {
    const environment = validateEnvironment(minimumEnvironment);

    expect(environment).toMatchObject({
      APP_ENV: 'development',
      APP_PORT: 3000,
      LOG_LEVEL: 'info',
      REQUEST_ID_HEADER: 'x-request-id',
      REQUEST_ID_TRUST_INCOMING: false,
      CORS_ORIGINS: '',
      DB_POOL_MAX: 10,
      AUTH_DB_POOL_MAX: 5,
      AUTH_ACCESS_TOKEN_TTL_SECONDS: 900,
      HEALTH_CHECK_TIMEOUT_MS: 2000,
    });
  });

  it('fails when the runtime database URL is missing', () => {
    expect(() =>
      validateEnvironment({
        DATABASE_SSL_MODE: 'disable',
      }),
    ).toThrow('DATABASE_URL');
  });

  it('rejects a non-PostgreSQL runtime URL without echoing it', () => {
    expect(() =>
      validateEnvironment({
        ...minimumEnvironment,
        DATABASE_URL: 'https://user:secret@example.com/database',
      }),
    ).toThrow('must be a valid PostgreSQL URL');
  });

  it('rejects CORS entries that include paths', () => {
    expect(() =>
      validateEnvironment({
        ...minimumEnvironment,
        CORS_ORIGINS: 'https://app.example.com/path',
      }),
    ).toThrow('without paths');
  });

  it('keeps the administrative URL optional at application runtime', () => {
    const environment = validateEnvironment({
      ...minimumEnvironment,
      DATABASE_ADMIN_URL: '',
    });

    expect(environment.DATABASE_ADMIN_URL).toBeUndefined();
  });

  it('rejects a signing secret shorter than 256 bits', () => {
    expect(() =>
      validateEnvironment({
        ...minimumEnvironment,
        AUTH_ACCESS_TOKEN_ACTIVE_SECRET: 'dG9vLXNob3J0',
      }),
    ).toThrow('AUTH_ACCESS_TOKEN_ACTIVE_SECRET');
  });

  it('rejects the public example signing placeholder', () => {
    expect(() =>
      validateEnvironment({
        ...minimumEnvironment,
        AUTH_ACCESS_TOKEN_ACTIVE_SECRET: 'change-me',
      }),
    ).toThrow('AUTH_ACCESS_TOKEN_ACTIVE_SECRET');
  });

  it('rejects an active signing key duplicated in previous keys', () => {
    expect(() =>
      validateEnvironment({
        ...minimumEnvironment,
        AUTH_ACCESS_TOKEN_PREVIOUS_KEYS: JSON.stringify({
          'test-v1': 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        }),
      }),
    ).toThrow('must not contain the active key ID');
  });

  it('requires the active Offline License key in the public verification set', () => {
    expect(() =>
      validateEnvironment({
        ...minimumEnvironment,
        OFFLINE_LICENSE_PUBLIC_KEYS: JSON.stringify({ historical: offlineLicensePublicKey }),
      }),
    ).toThrow('must contain the active Offline License key ID');
  });
});
