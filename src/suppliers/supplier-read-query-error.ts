export class SupplierReadQueryError extends Error {
  constructor(
    public readonly field: 'search' | 'cursor',
    public readonly constraint: string,
  ) {
    super(`Invalid Supplier read ${field}.`);
    this.name = 'SupplierReadQueryError';
  }
}
