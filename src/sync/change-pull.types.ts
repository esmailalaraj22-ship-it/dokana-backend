export interface ChangePullBounds {
  streamGeneration: number;
  headSequence: bigint;
  minimumReplayableSequence: bigint;
}

export interface ChangePullRow {
  storeSequence: bigint;
  eventId: string;
  contractVersion: number;
  representationVersion: number;
  entityType: string;
  entityKey: string;
  entityId: string | null;
  action: string;
  entityVersion: bigint;
  operationId: string | null;
  deviceId: string | null;
  representation: Record<string, unknown>;
  occurredAt: Date;
  capturedAt: Date;
}

export interface ChangePullItem {
  sequence: string;
  eventId: string;
  changeContractVersion: 1;
  representationVersion: 1;
  entityType: string;
  entityKey: string;
  entityId: string | null;
  action: string;
  entityVersion: string;
  operationId: string | null;
  deviceId: string | null;
  representation: Record<string, unknown>;
  occurredAt: string;
  capturedAt: string;
}

export interface ChangePullResponse {
  changeFeedVersion: 1;
  changes: ChangePullItem[];
  nextCursor: string;
  hasMore: boolean;
}
