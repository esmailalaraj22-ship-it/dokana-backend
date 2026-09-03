interface PostgreSqlError {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

function databaseError(error: unknown): PostgreSqlError | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate: PostgreSqlError = {
    code: 'code' in error ? error.code : undefined,
    constraint: 'constraint' in error ? error.constraint : undefined,
    cause: 'cause' in error ? error.cause : undefined,
  };
  if (candidate.code !== undefined || candidate.constraint !== undefined) {
    return candidate;
  }
  return candidate.cause === error ? undefined : databaseError(candidate.cause);
}

export function postgresqlErrorCode(error: unknown): string | undefined {
  const code = databaseError(error)?.code;
  return typeof code === 'string' ? code : undefined;
}
