import { BadRequestException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

interface ValidationDetail {
  field: string;
  constraints: string[];
}

function collectValidationDetails(errors: ValidationError[], parentPath = ''): ValidationDetail[] {
  return errors.flatMap((error) => {
    const field = parentPath ? `${parentPath}.${error.property}` : error.property;
    const current: ValidationDetail[] = error.constraints
      ? [{ field, constraints: Object.keys(error.constraints).sort() }]
      : [];

    return [...current, ...collectValidationDetails(error.children ?? [], field)];
  });
}

export function createValidationException(errors: ValidationError[]): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed.',
    details: collectValidationDetails(errors),
  });
}
