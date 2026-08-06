import { configureLocalAuthenticationEnvironment } from '../../scripts/configure-local-auth';

describe('local authentication environment configuration', () => {
  const generatedSecret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  it('replaces an invalid public placeholder with a generated secret', () => {
    const configured = configureLocalAuthenticationEnvironment(
      'AUTH_ACCESS_TOKEN_ACTIVE_SECRET=change-me\n',
      () => generatedSecret,
    );

    expect(configured).toContain(`AUTH_ACCESS_TOKEN_ACTIVE_SECRET=${generatedSecret}`);
    expect(configured).not.toContain('AUTH_ACCESS_TOKEN_ACTIVE_SECRET=change-me');
  });

  it('preserves an existing strong secret', () => {
    const existingSecret = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const createSigningSecret = jest.fn(() => generatedSecret);
    const configured = configureLocalAuthenticationEnvironment(
      `AUTH_ACCESS_TOKEN_ACTIVE_SECRET=${existingSecret}\n`,
      createSigningSecret,
    );

    expect(configured).toContain(`AUTH_ACCESS_TOKEN_ACTIVE_SECRET=${existingSecret}`);
    expect(createSigningSecret).not.toHaveBeenCalled();
  });
});
