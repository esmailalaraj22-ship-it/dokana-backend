import { serializeRequestForLogging, serializeResponseForLogging } from './logging.module';

describe('authentication-safe HTTP logging', () => {
  it('omits request credentials, tokens, headers, and connection values', () => {
    const serialized = serializeRequestForLogging({
      id: '9f97bb10-b68a-4474-888e-7244fc581bcb',
      method: 'POST',
      url: '/v1/auth/login',
      headers: {
        authorization: 'Bearer raw-access-token-sentinel',
      },
      body: {
        password: 'plain-password-sentinel',
        refreshToken: 'raw-refresh-token-sentinel',
      },
      connectionString: 'database-url-sentinel',
    });

    expect(serialized).toEqual({
      id: '9f97bb10-b68a-4474-888e-7244fc581bcb',
      method: 'POST',
      url: '/v1/auth/login',
    });
    expect(JSON.stringify(serialized)).not.toMatch(
      /plain-password|raw-access-token|raw-refresh-token|database-url/,
    );
  });

  it('omits response bodies that can contain issued tokens', () => {
    const serialized = serializeResponseForLogging({
      statusCode: 200,
      body: {
        accessToken: 'raw-access-token-sentinel',
        refreshToken: 'raw-refresh-token-sentinel',
      },
    });

    expect(serialized).toEqual({ statusCode: 200 });
    expect(JSON.stringify(serialized)).not.toContain('raw-');
  });
});
