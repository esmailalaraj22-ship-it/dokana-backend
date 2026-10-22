import { Inject, Injectable } from '@nestjs/common';

import {
  RECOVERY_ATTEMPT_ORDER,
  RECOVERY_ATTEMPT_RECORD_MAXIMUM_BYTES,
  parseRecoveryAttemptRecord,
  recoveryAttemptRecordKey,
  recoveryAttemptRecordSha256,
  serializeRecoveryAttemptRecord,
  type PreparedRecoveryAttemptRecord,
  type RecoveryAttemptPhase,
  type RecoveryAttemptRecord,
} from './recovery-attempt';
import {
  RECOVERY_ARTIFACT_STORAGE,
  type RecoveryArtifactStoragePort,
} from './recovery-artifact-storage.port';
import { sha256 } from './recovery-manifest';

const ALL_PHASES: readonly RecoveryAttemptPhase[] = [...RECOVERY_ATTEMPT_ORDER, 'ABORTED'];

export interface RecoveryAttemptState {
  prepared: PreparedRecoveryAttemptRecord;
  records: readonly RecoveryAttemptRecord[];
  current: RecoveryAttemptRecord;
  recordSha256: string;
}

@Injectable()
export class RecoveryAttemptCatalogService {
  constructor(
    @Inject(RECOVERY_ARTIFACT_STORAGE)
    private readonly storage: RecoveryArtifactStoragePort,
  ) {}

  async readAttempt(attemptId: string): Promise<RecoveryAttemptState | null> {
    const found = new Map<RecoveryAttemptPhase, RecoveryAttemptRecord>();
    for (const phase of ALL_PHASES) {
      const key = recoveryAttemptRecordKey(attemptId, phase);
      const body = await this.storage.readBuffer(key, RECOVERY_ATTEMPT_RECORD_MAXIMUM_BYTES);
      if (!body) continue;
      const metadata = await this.storage.headObject(key);
      if (!metadata?.encryption || metadata.checksumSha256 !== sha256(body)) {
        throw new Error('Recovery attempt record integrity verification failed.');
      }
      const record = parseRecoveryAttemptRecord(body);
      if (record.attemptId !== attemptId || record.phase !== phase) {
        throw new Error('Recovery attempt record identity is invalid.');
      }
      found.set(phase, record);
    }

    const prepared = found.get('PREPARED');
    if (!prepared) {
      if (found.size !== 0) throw new Error('Recovery attempt is missing its prepared record.');
      return null;
    }
    if (prepared.phase !== 'PREPARED') throw new Error('Recovery attempt is invalid.');

    const records: RecoveryAttemptRecord[] = [prepared];
    let previous: RecoveryAttemptRecord = prepared;
    let gapFound = false;
    for (const phase of RECOVERY_ATTEMPT_ORDER.slice(1)) {
      const record = found.get(phase);
      if (!record) {
        gapFound = true;
        continue;
      }
      if (gapFound) throw new Error('Recovery attempt phase sequence is incomplete.');
      assertRecordChain(record, previous, prepared);
      records.push(record);
      previous = record;
    }

    const aborted = found.get('ABORTED');
    if (aborted) {
      if (records.length !== 1 || previous.phase !== 'PREPARED') {
        throw new Error('Recovery attempt abort sequence is invalid.');
      }
      assertRecordChain(aborted, previous, prepared);
      records.push(aborted);
      previous = aborted;
    }

    return {
      prepared,
      records,
      current: previous,
      recordSha256: recoveryAttemptRecordSha256(previous),
    };
  }

  async writePrepared(record: PreparedRecoveryAttemptRecord): Promise<RecoveryAttemptState> {
    if (record.previousRecordSha256 !== null) {
      throw new Error('Prepared recovery attempt cannot have a predecessor.');
    }
    if (await this.readAttempt(record.attemptId)) {
      throw new Error('Recovery attempt already exists.');
    }
    await this.write(record);
    return requiredAttempt(await this.readAttempt(record.attemptId));
  }

  async append(record: RecoveryAttemptRecord): Promise<RecoveryAttemptState> {
    if (record.phase === 'PREPARED') {
      throw new Error('Prepared recovery attempt must use the initial write operation.');
    }
    const state = requiredAttempt(await this.readAttempt(record.attemptId));
    if (state.current.phase === 'ACTIVATED' || state.current.phase === 'ABORTED') {
      throw new Error('Recovery attempt is already terminal.');
    }
    if (record.recoveryPointId !== state.prepared.recoveryPointId) {
      throw new Error('Recovery attempt point identity changed.');
    }
    const expectedPhase =
      record.phase === 'ABORTED'
        ? state.current.phase === 'PREPARED'
          ? 'ABORTED'
          : null
        : RECOVERY_ATTEMPT_ORDER[RECOVERY_ATTEMPT_ORDER.indexOf(state.current.phase) + 1];
    if (record.phase !== expectedPhase) {
      throw new Error('Recovery attempt phase transition is invalid.');
    }
    if (record.previousRecordSha256 !== state.recordSha256) {
      throw new Error('Recovery attempt record chain is invalid.');
    }
    await this.write(record);
    return requiredAttempt(await this.readAttempt(record.attemptId));
  }

  private async write(record: RecoveryAttemptRecord): Promise<void> {
    const body = serializeRecoveryAttemptRecord(record);
    await this.storage.putBuffer({
      key: recoveryAttemptRecordKey(record.attemptId, record.phase),
      body,
      contentType: 'application/json',
      contentLength: body.byteLength,
      checksumSha256: sha256(body),
    });
  }
}

function assertRecordChain(
  record: RecoveryAttemptRecord,
  previous: RecoveryAttemptRecord,
  prepared: PreparedRecoveryAttemptRecord,
): void {
  if (
    record.recoveryPointId !== prepared.recoveryPointId ||
    record.previousRecordSha256 !== recoveryAttemptRecordSha256(previous)
  ) {
    throw new Error('Recovery attempt record chain is invalid.');
  }
}

function requiredAttempt(state: RecoveryAttemptState | null): RecoveryAttemptState {
  if (!state) throw new Error('Recovery attempt is unavailable.');
  return state;
}
