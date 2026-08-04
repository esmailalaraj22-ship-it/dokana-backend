import { isUuid, resolveRequestId } from './request-id';

describe('resolveRequestId', () => {
  const incomingId = 'f5c2da91-6713-4c1e-9d8a-5c38d6de9648';

  it('preserves a valid incoming UUID when explicitly trusted', () => {
    expect(resolveRequestId(incomingId, true)).toBe(incomingId);
  });

  it('replaces incoming identifiers when trust is disabled', () => {
    const result = resolveRequestId(incomingId, false);

    expect(result).not.toBe(incomingId);
    expect(isUuid(result)).toBe(true);
  });

  it('replaces malformed incoming identifiers even when trust is enabled', () => {
    expect(isUuid(resolveRequestId('not-a-uuid', true))).toBe(true);
  });
});
