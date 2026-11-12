import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';

export function releasePostgresClient(client: PoolClient, discard: boolean): void {
  try {
    if (discard) client.release(true);
    else client.release();
  } catch {
    Logger.error(
      'PostgreSQL client release failed; discarding the connection.',
      'DatabaseTransaction',
    );
    try {
      client.release(true);
    } catch {
      // pg-pool consumes its release-once guard before notifying release listeners.
      // If a listener throws, a second release cannot remove the client. The pool
      // installs its client error handler before that notification; use that same
      // eviction path so a half-released client cannot retain pool capacity.
      try {
        client.emit('error', new Error('PostgreSQL client release cleanup failed.'));
      } catch {
        // Pool error notification may itself throw after eviction. Preserve the
        // authoritative transaction outcome; the fixed message above reports it.
      }
    }
  }
}
