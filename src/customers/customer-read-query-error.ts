export class CustomerReadQueryError extends Error {
  constructor(
    public readonly field: 'search' | 'cursor',
    public readonly constraint: string,
  ) {
    super(`Invalid Customer read ${field}.`);
    this.name = 'CustomerReadQueryError';
  }
}
