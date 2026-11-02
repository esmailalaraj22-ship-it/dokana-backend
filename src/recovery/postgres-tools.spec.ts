import { runPostgresTool } from '../../scripts/recovery/postgres-tools';

describe('PostgreSQL recovery tool execution', () => {
  it('returns bounded successful output', async () => {
    await expect(
      runPostgresTool(process.execPath, ['-e', "process.stdout.write('ready')"], process.env, {
        timeoutMs: 2_000,
        maximumOutputBytes: 64,
      }),
    ).resolves.toEqual({ stdout: 'ready' });
  });

  it('classifies ordinary failures without exposing raw stderr', async () => {
    const secret = 'postgresql://user:secret@localhost/database';
    const failure = runPostgresTool(
      process.execPath,
      ['-e', `process.stderr.write(${JSON.stringify(secret)}); process.exit(1)`],
      process.env,
      { timeoutMs: 2_000, maximumOutputBytes: 256 },
    );

    await expect(failure).rejects.toThrow('PostgreSQL backup tool failed.');
    await expect(failure).rejects.not.toThrow(secret);
  });

  it('terminates a hung subprocess with a deterministic timeout failure', async () => {
    const startedAt = Date.now();
    await expect(
      runPostgresTool(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], process.env, {
        timeoutMs: 100,
        maximumOutputBytes: 64,
      }),
    ).rejects.toThrow('PostgreSQL backup tool timed out.');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('terminates a subprocess whose output exceeds the configured bound', async () => {
    await expect(
      runPostgresTool(
        process.execPath,
        ['-e', "process.stdout.write('x'.repeat(1024))"],
        process.env,
        { timeoutMs: 2_000, maximumOutputBytes: 64 },
      ),
    ).rejects.toThrow('PostgreSQL backup tool failed.');
  });
});
