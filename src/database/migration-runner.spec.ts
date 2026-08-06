import { parseCommand, validateRoleSwitches, verifyChecksums } from '../../scripts/migrate';
import { readMigrationFiles, sha256 } from '../../scripts/migrations/migration-files';

describe('controlled migration runner', () => {
  it('discovers migrations in deterministic numeric order', async () => {
    const files = await readMigrationFiles();

    expect(files.map((file) => file.filename)).toEqual([
      '0001_rls_context_function_privileges.sql',
      '0002_migration_ownership_foundation.sql',
      '0003_authentication_api_schema.sql',
      '0004_authentication_database_api.sql',
      '0005_refresh_rotation_session_boundary.sql',
    ]);
  });

  it('accepts only explicit commands', () => {
    expect(parseCommand('apply')).toBe('apply');
    expect(parseCommand('status')).toBe('status');
    expect(parseCommand('verify')).toBe('verify');
    expect(() => parseCommand('force')).toThrow('Expected migration command');
  });

  it('rejects arbitrary role switching and permits only allow-listed auth-owner migrations', () => {
    expect(() =>
      validateRoleSwitches({
        filename: '9999_untrusted.sql',
        absolutePath: 'ignored',
        contents: 'set role postgres;',
        checksumSha256: sha256('set role postgres;'),
      }),
    ).toThrow('prohibited role transition');

    expect(() =>
      validateRoleSwitches({
        filename: '0005_refresh_rotation_session_boundary.sql',
        absolutePath: 'ignored',
        contents: 'set local role shop_app_auth_owner;',
        checksumSha256: sha256('set local role shop_app_auth_owner;'),
      }),
    ).not.toThrow();
  });

  it('fails when an applied migration checksum differs or its file is missing', () => {
    const file = {
      filename: '0001_example.sql',
      absolutePath: 'ignored',
      contents: 'select 1;',
      checksumSha256: sha256('select 1;'),
    };

    expect(() =>
      verifyChecksums(
        [file],
        [
          {
            filename: file.filename,
            checksumSha256: sha256('modified'),
          },
        ],
      ),
    ).toThrow('checksum mismatch');
    expect(() =>
      verifyChecksums(
        [],
        [
          {
            filename: file.filename,
            checksumSha256: file.checksumSha256,
          },
        ],
      ),
    ).toThrow('file is missing');
  });
});
