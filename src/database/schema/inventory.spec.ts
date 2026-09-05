import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getTableConfig } from 'drizzle-orm/pg-core';

import { validateRoleSwitches, validateTransactionControl } from '../../../scripts/migrate';
import {
  inventoryCostStates,
  inventoryMovements,
  manualInventoryEntries,
  stockBalances,
  stockCountItems,
  stockCounts,
} from './inventory';

describe('Inventory physical schema boundary', () => {
  it('uses only known, unknown, and pending authoritative states', () => {
    expect(inventoryCostStates).toEqual(['known', 'unknown', 'pending']);
  });

  it.each([
    inventoryMovements,
    stockBalances,
    manualInventoryEntries,
    stockCounts,
    stockCountItems,
  ])('keeps every quantity, value, and version bigint lossless', (table) => {
    for (const column of getTableConfig(table).columns.filter(
      (column) => column.getSQLType() === 'bigint',
    )) {
      expect(column.mapFromDriverValue('9007199254740993')).toBe(9007199254740993n);
      expect(column.mapFromDriverValue('9223372036854775807')).toBe(9223372036854775807n);
    }
  });

  it('has no Supplier Invoice relationship and retains nullable input cost', () => {
    const config = getTableConfig(manualInventoryEntries);
    expect(config.columns.some((column) => /supplier|invoice|receipt/.test(column.name))).toBe(
      false,
    );
    expect(
      config.foreignKeys.some((key) =>
        /supplier|invoice|receipt/.test(getTableConfig(key.reference().foreignTable).name),
      ),
    ).toBe(false);
    expect(manualInventoryEntries.totalPurchaseCostMinor.notNull).toBe(false);
    expect(manualInventoryEntries.totalPurchaseCostMinor.hasDefault).toBe(false);
  });

  it('leaves transaction ownership and role transitions with the controlled runner', () => {
    const absolutePath = resolve('database/migrations/0007_inventory_physical_foundation.sql');
    const file = {
      filename: '0007_inventory_physical_foundation.sql',
      absolutePath,
      contents: readFileSync(absolutePath, 'utf8'),
      checksumSha256: '',
    };
    expect(() => validateTransactionControl(file)).not.toThrow();
    expect(() => validateRoleSwitches(file)).not.toThrow();
  });
});
