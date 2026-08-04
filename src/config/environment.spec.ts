import { validateEnvironment } from './environment';

const minimumEnvironment = {
  DATABASE_URL: 'postgresql://runtime:password@localhost:5432/dokana',
  DATABASE_SSL_MODE: 'disable',
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
});
