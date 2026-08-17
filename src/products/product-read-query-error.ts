export class ProductReadQueryError extends Error {
  constructor(
    public readonly field: 'search' | 'cursor',
    public readonly constraint: string,
  ) {
    super(`Invalid Product read ${field}.`);
    this.name = 'ProductReadQueryError';
  }
}
