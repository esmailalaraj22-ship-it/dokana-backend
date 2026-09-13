export class SaleReadQueryError extends Error {
  constructor(
    readonly field: string,
    readonly constraint: string,
  ) {
    super(`Invalid Sale read query field: ${field}.`);
    this.name = 'SaleReadQueryError';
  }
}
