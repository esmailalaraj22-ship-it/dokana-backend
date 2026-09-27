export class SaleReturnReadQueryError extends Error {
  constructor(
    public readonly field: 'cursor',
    public readonly constraint: string,
  ) {
    super(constraint);
  }
}
