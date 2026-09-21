import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.types';
import { parseStoredCustomerFinancialResponse } from './customer-credit-response';
import type { CustomerFinancialResponse } from './customer-credit.types';
import { parseStoredCustomerFinancialCorrectionResponse } from './customer-financial-correction-response';
import type { CustomerFinancialCorrectionFamily } from './customer-financial-correction-command';
import type { CustomerFinancialCorrectionResponse } from './customer-financial-correction.types';
import type {
  CustomerFinancialCorrectionLineageResponse,
  ResolvedCustomerFinancialLineage,
} from './customer-financial-correction-read.types';
import { parseStoredCustomerCollectionPostingResponse } from './customer-payment-posting-response';

const CORRECTION_AGGREGATE = 'customer_financial_corrections';

interface OperationRow extends Record<string, unknown> {
  operationId: string;
  aggregateType: string;
  action: string;
  responseBody: unknown;
}

interface RootOperation {
  operationId: string;
  family: CustomerFinancialCorrectionFamily;
  ownCorrection: CustomerFinancialCorrectionResponse | null;
}

@Injectable()
export class CustomerFinancialCorrectionReadRepository {
  async resolve(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
    transactionGroupIds: string[],
  ): Promise<Map<string, ResolvedCustomerFinancialLineage>> {
    const uniqueGroups = [...new Set(transactionGroupIds)];
    if (uniqueGroups.length === 0) return new Map();
    const groupList = sql.join(
      uniqueGroups.map((groupId) => sql`${groupId}`),
      sql`,`,
    );

    const operationRows = (
      await transaction.execute<OperationRow>(sql`
        select operation_id as "operationId",aggregate_type as "aggregateType",action,
          response_body as "responseBody"
        from sync.processed_operations
        where store_id=${storeId}::uuid and status='applied' and response_code=201
          and aggregate_type in (
            'customer_collections','customer_financial_adjustments',${CORRECTION_AGGREGATE}
          )
          and response_body ->> 'customerId'=${customerId}
          and (
            response_body ->> 'collectionId' in (${groupList})
            or response_body ->> 'transactionGroupId' in (${groupList})
            or response_body #>> '{replacement,collectionId}' in (${groupList})
            or response_body #>> '{replacement,transactionGroupId}' in (${groupList})
          )
      `)
    ).rows;
    const correctionRows = (
      await transaction.execute<OperationRow>(sql`
        select operation_id as "operationId",aggregate_type as "aggregateType",action,
          response_body as "responseBody"
        from sync.processed_operations
        where store_id=${storeId}::uuid and status='applied' and response_code=201
          and aggregate_type=${CORRECTION_AGGREGATE}
          and response_body ->> 'customerId'=${customerId}
      `)
    ).rows;

    const roots = new Map<string, RootOperation>();
    for (const row of operationRows) {
      this.addRootMappings(roots, uniqueGroups, row);
    }
    for (const groupId of uniqueGroups) {
      if (!roots.has(groupId)) {
        throw new Error('Customer financial operation root is missing.');
      }
    }

    const corrections = correctionRows.map((row) => {
      if (row.aggregateType !== CORRECTION_AGGREGATE) {
        throw new Error('Customer financial correction read is inconsistent.');
      }
      return parseStoredCustomerFinancialCorrectionResponse(row.responseBody);
    });
    const byTarget = new Map<string, CustomerFinancialCorrectionResponse>();
    for (const correction of corrections) {
      if (byTarget.has(correction.targetOperationId)) {
        throw new Error('Customer financial correction lineage is branched.');
      }
      byTarget.set(correction.targetOperationId, correction);
    }

    return new Map(
      uniqueGroups.map((groupId) => {
        const root = roots.get(groupId);
        if (!root) throw new Error('Customer financial operation root is missing.');
        return [groupId, this.buildLineage(root, byTarget)] as const;
      }),
    );
  }

  private addRootMappings(
    roots: Map<string, RootOperation>,
    requestedGroups: string[],
    row: OperationRow,
  ): void {
    if (
      row.aggregateType === 'customer_collections' &&
      row.action === 'customer_collections.post'
    ) {
      const response = parseStoredCustomerCollectionPostingResponse(row.responseBody);
      this.addRoot(roots, requestedGroups, response.collectionId, {
        operationId: response.operationId,
        family: 'customer_collection',
        ownCorrection: null,
      });
      return;
    }
    if (row.aggregateType === 'customer_financial_adjustments') {
      const response = parseStoredCustomerFinancialResponse(row.responseBody);
      this.addRoot(roots, requestedGroups, response.transactionGroupId, {
        operationId: response.operationId,
        family: this.familyForFinancial(response),
        ownCorrection: null,
      });
      return;
    }
    if (row.aggregateType === CORRECTION_AGGREGATE) {
      const response = parseStoredCustomerFinancialCorrectionResponse(row.responseBody);
      this.addRoot(roots, requestedGroups, response.transactionGroupId, {
        operationId: response.operationId,
        family: response.family,
        ownCorrection: response,
      });
      const replacementGroup =
        response.replacement === null
          ? null
          : 'collectionId' in response.replacement
            ? response.replacement.collectionId
            : response.replacement.transactionGroupId;
      if (replacementGroup !== null) {
        this.addRoot(roots, requestedGroups, replacementGroup, {
          operationId: response.operationId,
          family: response.family,
          ownCorrection: response,
        });
      }
      return;
    }
    throw new Error('Customer financial operation root is inconsistent.');
  }

  private addRoot(
    roots: Map<string, RootOperation>,
    requestedGroups: string[],
    groupId: string,
    root: RootOperation,
  ): void {
    if (!requestedGroups.includes(groupId)) return;
    const prior = roots.get(groupId);
    if (prior && prior.operationId !== root.operationId) {
      throw new Error('Customer financial transaction group has multiple roots.');
    }
    roots.set(groupId, root);
  }

  private familyForFinancial(
    response: CustomerFinancialResponse,
  ): CustomerFinancialCorrectionFamily {
    if (response.action === 'apply_customer_credit') return 'customer_credit_application';
    if (response.action === 'refund_customer_credit') return 'customer_credit_refund';
    return 'customer_receivable_settlement';
  }

  private buildLineage(
    root: RootOperation,
    byTarget: Map<string, CustomerFinancialCorrectionResponse>,
  ): ResolvedCustomerFinancialLineage {
    const chain: CustomerFinancialCorrectionResponse[] = [];
    const visited = new Set([root.operationId]);
    let currentOperationId = root.operationId;
    let successor = byTarget.get(currentOperationId);
    while (successor) {
      if (successor.family !== root.family || visited.has(successor.operationId)) {
        throw new Error('Customer financial correction lineage is inconsistent.');
      }
      chain.push(successor);
      visited.add(successor.operationId);
      currentOperationId = successor.operationId;
      successor = byTarget.get(currentOperationId);
    }

    const direct = chain[0] ?? null;
    const terminal = chain.at(-1) ?? root.ownCorrection;
    const ownCancelled = root.ownCorrection?.intent === 'cancel';
    const lineage: CustomerFinancialCorrectionLineageResponse = {
      rootOperationId: root.operationId,
      origin:
        root.ownCorrection === null
          ? null
          : {
              correctionOperationId: root.ownCorrection.operationId,
              targetOperationId: root.ownCorrection.targetOperationId,
              intent: root.ownCorrection.intent,
              reason: root.ownCorrection.reason,
              occurredAt: root.ownCorrection.occurredAt,
            },
      state:
        direct?.intent === 'cancel' || ownCancelled ? 'cancelled' : direct ? 'corrected' : 'active',
      correctedByOperationId: direct?.operationId ?? null,
      correctionIntent: direct?.intent ?? null,
      correctionReason: direct?.reason ?? null,
      currentActiveOperationId:
        terminal?.intent === 'cancel' ? null : (terminal?.operationId ?? root.operationId),
    };
    return { lineage, rootCorrection: root.ownCorrection, corrections: chain };
  }
}
