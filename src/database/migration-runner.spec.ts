import type { PoolClient } from 'pg';

import {
  applyMigration,
  bootstrapOnlyMigrations,
  parseCommand,
  validateRoleSwitches,
  validateTransactionControl,
  verifyChecksums,
} from '../../scripts/migrate';
import { readMigrationFiles, sha256 } from '../../scripts/migrations/migration-files';

function migrationOf(contents: string) {
  return {
    filename: '9999_transaction_control_case.sql',
    absolutePath: 'ignored',
    contents,
    checksumSha256: sha256(contents),
  };
}

describe('controlled migration runner', () => {
  it('discovers migrations in deterministic numeric order', async () => {
    const files = await readMigrationFiles();

    expect(files.map((file) => file.filename)).toEqual([
      '0001_rls_context_function_privileges.sql',
      '0002_migration_ownership_foundation.sql',
      '0003_authentication_api_schema.sql',
      '0004_authentication_database_api.sql',
      '0005_refresh_rotation_session_boundary.sql',
      '0006_money_movement_period_guard_execute.sql',
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

  it('accepts every runner-applicable migration and rejects the self-transactional bootstrap file', async () => {
    const files = await readMigrationFiles();
    const runnerApplicable = files.filter((file) => !bootstrapOnlyMigrations.has(file.filename));

    expect(runnerApplicable.length).toBeGreaterThan(0);
    for (const file of runnerApplicable) {
      expect(() => validateTransactionControl(file)).not.toThrow();
    }

    // 0001 manages its own transaction and is registered without replay; the
    // runner must keep refusing to execute it even if the bootstrap gate failed.
    const bootstrapSelfTransactional = files.find(
      (file) => file.filename === '0001_rls_context_function_privileges.sql',
    );
    if (!bootstrapSelfTransactional) {
      throw new Error('Expected migration 0001 to exist.');
    }
    expect(() => validateTransactionControl(bootstrapSelfTransactional)).toThrow(
      'prohibited transaction control',
    );
  });

  it('rejects every prohibited top-level transaction-control statement', () => {
    const prohibited = [
      'begin;',
      'BEGIN TRANSACTION;',
      'start transaction;',
      'START\n  TRANSACTION isolation level serializable;',
      'commit;',
      'COMMIT AND CHAIN;',
      "commit prepared 'dokana';",
      'end;',
      'END TRANSACTION;',
      'rollback;',
      'ROLLBACK TO SAVEPOINT partial;',
      "rollback prepared 'dokana';",
      'abort;',
      'savepoint partial;',
      'release savepoint partial;',
      "prepare transaction 'dokana';",
    ];

    for (const statement of prohibited) {
      expect(() => validateTransactionControl(migrationOf(`select 1;\n${statement}`))).toThrow(
        'prohibited transaction control',
      );
    }
  });

  it('does not reject transaction keywords inside comments, strings, or function bodies', () => {
    const legitimate = [
      '-- rollback guidance: run ROLLBACK; then COMMIT elsewhere\nselect 1;',
      '/* BEGIN; COMMIT; /* nested SAVEPOINT s1; */ ROLLBACK; */\nselect 1;',
      "insert into platform.notes (body) values ('BEGIN; COMMIT; ROLLBACK;');",
      "select E'COMMIT;\\n BEGIN;';",
      'create function platform.example() returns void language plpgsql as $$\n' +
        'begin\n  perform 1;\nend;\n$$;',
      'do $tag$\nbegin\n  null; -- COMMIT inside body comment\nend;\n$tag$;',
      `select 1 as "commit"; select 'it''s a begin';`,
      "comment on function platform.example() is 'never a COMMIT';",
      'prepare plan_name as select 1;',
    ];

    for (const contents of legitimate) {
      expect(() => validateTransactionControl(migrationOf(contents))).not.toThrow();
    }
  });

  it('never executes or records a migration rejected for transaction control', async () => {
    const client = { query: jest.fn() } as unknown as PoolClient;

    await expect(
      applyMigration(client, migrationOf('create table platform.x (id integer);\ncommit;')),
    ).rejects.toThrow('prohibited transaction control');
    expect(client.query).not.toHaveBeenCalled();
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
