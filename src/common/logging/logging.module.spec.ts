import { serializeRequestForLogging, serializeResponseForLogging } from './logging.module';
import { requestPathForObservability } from './request-path';

describe('privacy-safe HTTP logging', () => {
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

  it('removes Customer query state before creating the structured request record', () => {
    const serialized = serializeRequestForLogging({
      id: '9f97bb10-b68a-4474-888e-7244fc581bcb',
      method: 'GET',
      url: '/v1/customers?search=CUSTOMER_SEARCH_SECRET&cursor=CUSTOMER_CURSOR_SECRET',
      query: {
        search: 'CUSTOMER_SEARCH_SECRET',
        cursor: 'CUSTOMER_CURSOR_SECRET',
      },
    });

    expect(serialized).toEqual({
      id: '9f97bb10-b68a-4474-888e-7244fc581bcb',
      method: 'GET',
      url: '/v1/customers',
    });
    expect(JSON.stringify(serialized)).not.toMatch(/CUSTOMER_(SEARCH|CURSOR)_SECRET/);
  });

  it('uses a fixed safe value when structural request-target parsing fails', () => {
    const path = requestPathForObservability('http://[?search=CUSTOMER_MALFORMED_TARGET_SECRET');

    expect(path).toBe('[INVALID_REQUEST_PATH]');
    expect(path).not.toContain('CUSTOMER_MALFORMED_TARGET_SECRET');
    expect(requestPathForObservability('/health/live?probe=value')).toBe('/health/live');
    expect(requestPathForObservability('*')).toBe('*');
  });
});
