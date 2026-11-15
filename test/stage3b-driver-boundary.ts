import type { Pool, PoolClient, QueryResult } from 'pg';

// All SQL still executes against PostgreSQL. Only the selected operation's
// driver boundary is intercepted; pooled clients are restored before release.
export function interceptOperationQueries(
  pool: Pool,
  operationId: string,
  hook: (text: string, execute: () => Promise<QueryResult>) => Promise<QueryResult>,
): () => void {
  const connect = pool.connect.bind(pool);
  const acquisition = jest.spyOn(pool, 'connect').mockImplementation(async () => {
    const client = await connect();
    const query = client.query.bind(client);
    const release = client.release.bind(client);
    let selected = false;
    const queries = jest.spyOn(client, 'query').mockImplementation((async (...args: unknown[]) => {
      const config = args[0] as string | { text: string; values?: unknown[] };
      const text = typeof config === 'string' ? config : config.text;
      const values = (args[1] ?? (typeof config === 'object' ? config.values : [])) as unknown[];
      if (text.includes('sync.claim_operation') && values.includes(operationId)) selected = true;
      const execute = () => Reflect.apply(query, client, args) as Promise<QueryResult>;
      return selected ? hook(text, execute) : execute();
    }) as PoolClient['query']);
    const releases = jest.spyOn(client, 'release').mockImplementation((error) => {
      queries.mockRestore();
      releases.mockRestore();
      release(error);
    });
    return client;
  });
  return () => acquisition.mockRestore();
}
