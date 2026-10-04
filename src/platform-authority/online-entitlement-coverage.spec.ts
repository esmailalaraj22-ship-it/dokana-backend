import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directAuthorityFiles = [
  'src/money-transfers/money-transfer-posting.repository.ts',
  'src/inventory/inventory-posting.repository.ts',
  'src/suppliers/supplier-invoice-posting.repository.ts',
  'src/sales/sale-posting.repository.ts',
  'src/expenses/expense-recognition.repository.ts',
  'src/returns/sale-return-correction.repository.ts',
] as const;

const sharedBoundaryFiles = [
  'src/money-movements/money-movement-posting.repository.ts',
  'src/customers/customer-write.repository.ts',
  'src/sales/customer-payment-posting.repository.ts',
  'src/returns/sale-return-posting.repository.ts',
] as const;

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('online entitlement write-path coverage', () => {
  it('keeps the shared business-write transaction on the atomic PostgreSQL authority', () => {
    const databaseService = source('src/database/database.service.ts');
    expect(databaseService).toContain('ledger.lock_effective_entitlement');
    expect(databaseService).toContain('assertBusinessWriteAllowed(transaction, context.storeId)');
  });

  it.each(directAuthorityFiles)(
    '%s invokes central entitlement after replay-first locking',
    (path) => {
      expect(source(path)).toContain('this.database.assertBusinessWriteAllowed(');
    },
  );

  it.each(sharedBoundaryFiles)(
    '%s inherits central entitlement through the shared boundary',
    (path) => {
      expect(source(path)).toContain('this.database.withBusinessWriteTransaction(');
    },
  );
});
