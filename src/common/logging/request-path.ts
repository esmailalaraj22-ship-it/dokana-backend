const requestTargetBase = 'http://dokana.invalid';
const invalidRequestPath = '[INVALID_REQUEST_PATH]';

export function requestPathForObservability(requestTarget: unknown): string {
  if (typeof requestTarget !== 'string' || requestTarget.length === 0) {
    return invalidRequestPath;
  }

  if (requestTarget === '*') {
    return requestTarget;
  }

  try {
    return new URL(requestTarget, requestTargetBase).pathname || '/';
  } catch {
    return invalidRequestPath;
  }
}
