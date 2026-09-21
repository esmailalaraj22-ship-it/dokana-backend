import type { CustomerFinancialCorrectionResponse } from './customer-financial-correction.types';

export interface CustomerFinancialCorrectionOriginResponse {
  correctionOperationId: string;
  targetOperationId: string;
  intent: 'cancel' | 'edit';
  reason: string;
  occurredAt: string;
}

export interface CustomerFinancialCorrectionLineageResponse {
  rootOperationId: string;
  origin: CustomerFinancialCorrectionOriginResponse | null;
  state: 'active' | 'corrected' | 'cancelled';
  correctedByOperationId: string | null;
  correctionIntent: 'cancel' | 'edit' | null;
  correctionReason: string | null;
  currentActiveOperationId: string | null;
}

export interface ResolvedCustomerFinancialLineage {
  lineage: CustomerFinancialCorrectionLineageResponse;
  rootCorrection: CustomerFinancialCorrectionResponse | null;
  corrections: CustomerFinancialCorrectionResponse[];
}
