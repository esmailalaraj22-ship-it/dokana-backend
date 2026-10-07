import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { isUuid } from '../common/logging/request-id';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  canonicalizeOfflineLicensePayload,
  OfflineLicenseCryptoService,
} from '../offline-licenses/offline-license-crypto';
import { OfflineLicenseRepository } from '../offline-licenses/offline-license.repository';
import type { OfflineLicenseValidationRecord } from '../offline-licenses/offline-license.types';
import {
  BootstrapArtifactExpiredError,
  BootstrapArtifactIntegrityError,
  BootstrapArtifactNotFoundError,
  BootstrapArtifactStore,
  type BootstrapArtifactWriter,
} from './bootstrap-artifact.store';
import {
  bootstrapBusinessDatasets,
  bootstrapPageSize,
  bootstrapVersion,
  sqliteSchemaVersion,
  syncChangeFeedVersion,
  syncProtocolVersion,
} from './bootstrap-datasets';
import { BootstrapRepository } from './bootstrap.repository';
import type {
  BootstrapBoundary,
  BootstrapDatasetDefinition,
  BootstrapDatasetManifest,
  BootstrapJsonValue,
  BootstrapManifest,
  BootstrapManifestCore,
  BootstrapPage,
  BootstrapRecord,
  BootstrapStartCommand,
} from './bootstrap.types';

function databaseErrorCode(error: unknown): string | undefined {
  let candidate: unknown = error;
  for (
    let depth = 0;
    depth < 5 && typeof candidate === 'object' && candidate !== null;
    depth += 1
  ) {
    if ('code' in candidate && typeof candidate.code === 'string') return candidate.code;
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return undefined;
}

function datasetChecksum(pageChecksums: readonly string[]): string {
  const hash = createHash('sha256');
  for (const checksum of pageChecksums) hash.update(checksum).update('\n');
  return hash.digest('hex');
}

@Injectable()
export class BootstrapService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: BootstrapRepository,
    private readonly artifacts: BootstrapArtifactStore,
    private readonly licenses: OfflineLicenseRepository,
    private readonly licenseCrypto: OfflineLicenseCryptoService,
    private readonly config: AppConfigService,
  ) {}

  async start(
    principal: AuthenticatedPrincipal,
    context: TenantTransactionContext,
    command: BootstrapStartCommand,
  ): Promise<BootstrapManifest> {
    this.assertContext(principal, context);
    if (command.bootstrapVersion !== bootstrapVersion || !isUuid(command.licenseId)) {
      throw this.validationError();
    }

    const sessionId = randomUUID();
    const writer = await this.artifacts.begin(sessionId);
    try {
      const manifestCore = await this.database.withTenantSnapshotTransaction(
        context,
        async (transaction) => {
          const boundary = await this.repository.readBoundary(transaction, context);
          const expiresAt = this.resolveExpiry(principal, boundary.serverTime);
          const license = await this.readVerifiedLicense(
            transaction,
            context,
            command.licenseId.toLowerCase(),
            boundary,
          );
          return this.materialize(
            writer,
            transaction,
            principal,
            context,
            boundary,
            license,
            sessionId,
            expiresAt,
          );
        },
      );
      return await writer.finalize(manifestCore);
    } catch (error) {
      await writer.abort();
      this.translateStartError(error);
    }
  }

  async readPage(
    principal: AuthenticatedPrincipal,
    context: TenantTransactionContext,
    sessionId: string,
    datasetId: string,
    pageNumberValue: string,
  ): Promise<BootstrapPage> {
    this.assertContext(principal, context);
    const pageNumber = Number(pageNumberValue);
    if (
      !isUuid(sessionId) ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(datasetId) ||
      !Number.isSafeInteger(pageNumber) ||
      pageNumber < 1
    ) {
      throw this.validationError();
    }
    try {
      const manifest = await this.artifacts.readManifest(sessionId.toLowerCase());
      if (manifest.storeId !== context.storeId || manifest.deviceId !== context.deviceId) {
        throw new BootstrapArtifactNotFoundError();
      }
      return await this.artifacts.readPage(manifest, datasetId, pageNumber);
    } catch (error) {
      if (error instanceof BootstrapArtifactNotFoundError) {
        throw new NotFoundException({
          code: 'BOOTSTRAP_PAGE_NOT_FOUND',
          message: 'Bootstrap page not found.',
        });
      }
      if (
        error instanceof BootstrapArtifactExpiredError ||
        error instanceof BootstrapArtifactIntegrityError
      ) {
        throw new GoneException({
          code: 'BOOTSTRAP_RESTART_REQUIRED',
          message: 'The bootstrap session must be restarted.',
        });
      }
      throw error;
    }
  }

  private async materialize(
    writer: BootstrapArtifactWriter,
    transaction: DatabaseTransaction,
    principal: AuthenticatedPrincipal,
    context: TenantTransactionContext,
    boundary: BootstrapBoundary,
    license: OfflineLicenseValidationRecord,
    sessionId: string,
    expiresAt: Date,
  ): Promise<BootstrapManifestCore> {
    const datasets: BootstrapDatasetManifest[] = [];
    for (const definition of bootstrapBusinessDatasets) {
      this.assertGenerationActive(expiresAt);
      if (definition.id === 'devices') {
        datasets.push(
          await this.writeRecords(writer, boundary, sessionId, datasets.length + 1, 'local_users', [
            this.localUserRecord(principal, boundary),
          ]),
        );
      }
      datasets.push(
        await this.writeDatabaseDataset(
          writer,
          transaction,
          context,
          boundary,
          sessionId,
          datasets.length + 1,
          definition,
          expiresAt,
        ),
      );
      if (definition.id === 'app_settings') {
        const entitlement = this.entitlementRecords(principal, boundary, license);
        for (const [id, records] of entitlement) {
          datasets.push(
            await this.writeRecords(writer, boundary, sessionId, datasets.length + 1, id, records),
          );
        }
      }
    }

    return {
      bootstrapVersion,
      protocolVersion: syncProtocolVersion,
      changeFeedVersion: syncChangeFeedVersion,
      sqliteSchemaVersion,
      sessionId,
      datasetId: sessionId,
      bootstrapGenerationId: sessionId,
      storeId: context.storeId,
      deviceId: context.deviceId,
      status: 'ready',
      serverTime: boundary.serverTime.toISOString(),
      expiresAt: expiresAt.toISOString(),
      snapshotId: boundary.snapshotId,
      baseCursor: boundary.baseWatermark,
      pageSize: bootstrapPageSize,
      encoding: {
        bigInteger: 'decimal_string',
        quantity: 'integer_milli_units_as_decimal_string',
        money: 'integer_minor_units_as_decimal_string',
        timestamp: 'rfc3339_utc',
      },
      activationContract: {
        stagingModel: 'separate_sqlite_database',
        validation: ['page_checksums', 'dataset_checksums', 'manifest_checksum', 'foreign_keys'],
        activation: 'atomic_database_swap_with_base_cursor',
        incompleteBootstrap: 'must_not_activate',
      },
      datasets,
    };
  }

  private async writeDatabaseDataset(
    writer: BootstrapArtifactWriter,
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    boundary: BootstrapBoundary,
    sessionId: string,
    order: number,
    definition: BootstrapDatasetDefinition,
    expiresAt: Date,
  ): Promise<BootstrapDatasetManifest> {
    let offset = 0;
    let pageNumber = 1;
    let recordCount = 0;
    const pageChecksums: string[] = [];
    for (;;) {
      this.assertGenerationActive(expiresAt);
      const records = await this.repository.readDatasetPage(
        transaction,
        context,
        definition,
        offset,
        bootstrapPageSize,
      );
      if (records.length === 0) break;
      const page = await writer.writePage({
        bootstrapVersion,
        sessionId,
        snapshotId: boundary.snapshotId,
        datasetId: definition.id,
        pageNumber,
        recordCount: records.length,
        records,
      });
      pageChecksums.push(page.checksum);
      recordCount += records.length;
      offset += records.length;
      pageNumber += 1;
      if (records.length < bootstrapPageSize) break;
    }
    return {
      id: definition.id,
      order,
      recordCount,
      pageCount: pageChecksums.length,
      checksum: datasetChecksum(pageChecksums),
    };
  }

  private async writeRecords(
    writer: BootstrapArtifactWriter,
    boundary: BootstrapBoundary,
    sessionId: string,
    order: number,
    datasetId: string,
    records: BootstrapRecord[],
  ): Promise<BootstrapDatasetManifest> {
    if (records.length === 0) {
      return { id: datasetId, order, recordCount: 0, pageCount: 0, checksum: datasetChecksum([]) };
    }
    const page = await writer.writePage({
      bootstrapVersion,
      sessionId,
      snapshotId: boundary.snapshotId,
      datasetId,
      pageNumber: 1,
      recordCount: records.length,
      records,
    });
    return {
      id: datasetId,
      order,
      recordCount: records.length,
      pageCount: 1,
      checksum: datasetChecksum([page.checksum]),
    };
  }

  private localUserRecord(
    principal: AuthenticatedPrincipal,
    boundary: BootstrapBoundary,
  ): BootstrapRecord {
    return {
      id: principal.userId,
      store_id: principal.storeId,
      full_name: principal.fullName,
      email: principal.email,
      normalized_email: principal.email.trim().toLowerCase(),
      role: 'owner',
      status: 'active',
      created_at: boundary.serverTime.toISOString(),
      updated_at: boundary.serverTime.toISOString(),
      version: principal.membershipVersion,
    };
  }

  private entitlementRecords(
    principal: AuthenticatedPrincipal,
    boundary: BootstrapBoundary,
    record: OfflineLicenseValidationRecord,
  ): readonly (readonly [string, BootstrapRecord[]])[] {
    const payload = record.signedPayload;
    const verificationKey = this.licenseCrypto.verificationKey(record.keyId);
    const serverTime = boundary.serverTime.toISOString();
    return [
      [
        'offline_license_verification_keys',
        [
          {
            key_id: verificationKey.keyId,
            algorithm: verificationKey.algorithm,
            public_key_spki: verificationKey.publicKeySpki,
            status: 'active',
            first_trusted_at: serverTime,
            last_trusted_at: serverTime,
          },
        ],
      ],
      [
        'local_license',
        [
          {
            id: record.licenseId,
            store_id: principal.storeId,
            device_id: principal.deviceId,
            license_version: '1',
            subscription_id: payload.subscriptionId,
            subscription_version: payload.subscriptionVersion,
            central_entitlement_end: payload.centralEntitlementEnd,
            signing_key_id: record.keyId,
            signing_algorithm: 'Ed25519',
            signed_payload: payload as unknown as BootstrapJsonValue,
            signature: record.signature,
            issued_at: payload.issuedAt,
            expires_at: payload.offlineValidUntil,
            last_trusted_server_at: serverTime,
            last_seen_device_time: null,
            revoked_at: null,
            revoke_reason: null,
            last_revalidated_at: serverTime,
            verification_state: 'verified',
            status: 'active',
          },
        ],
      ],
      [
        'offline_trusted_time_state',
        [
          {
            store_id: principal.storeId,
            device_id: principal.deviceId,
            license_id: record.licenseId,
            state_version: '1',
            last_trusted_server_at: serverTime,
            last_seen_device_time: null,
            last_trusted_local_sequence: '0',
            clock_rollback_suspected: false,
            online_revalidation_required: principal.storeStatus === 'read_only',
            observed_store_status: principal.storeStatus,
            observed_store_status_at: serverTime,
            updated_at: serverTime,
          },
        ],
      ],
    ];
  }

  private async readVerifiedLicense(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    licenseId: string,
    boundary: BootstrapBoundary,
  ): Promise<OfflineLicenseValidationRecord> {
    const record = await this.licenses.readForValidation(transaction, context, licenseId);
    if (
      !record ||
      record.revokedAt ||
      record.expiresAt.getTime() <= boundary.serverTime.getTime()
    ) {
      throw this.licenseUnavailable();
    }
    const signed = {
      algorithm: 'Ed25519' as const,
      payload: record.signedPayload,
      signature: record.signature,
    };
    let verified;
    try {
      verified = this.licenseCrypto.verify(signed);
    } catch {
      throw this.licenseUnavailable();
    }
    if (
      verified.licenseId !== record.licenseId ||
      verified.storeId !== context.storeId ||
      verified.deviceId !== context.deviceId ||
      verified.subscriptionId !== record.subscriptionId ||
      verified.signingKeyId !== record.keyId ||
      canonicalizeOfflineLicensePayload(verified) !==
        canonicalizeOfflineLicensePayload(record.signedPayload)
    ) {
      throw this.licenseUnavailable();
    }
    return record;
  }

  private resolveExpiry(principal: AuthenticatedPrincipal, serverTime: Date): Date {
    const accessWindowEnd =
      serverTime.getTime() + this.config.authenticationTokens.accessTokenTtlSeconds * 1_000;
    const expiresAt = new Date(Math.min(accessWindowEnd, principal.sessionExpiresAt.getTime()));
    if (expiresAt.getTime() <= serverTime.getTime()) throw this.licenseUnavailable();
    return expiresAt;
  }

  private assertGenerationActive(expiresAt: Date): void {
    if (Date.now() >= expiresAt.getTime()) {
      throw new GoneException({
        code: 'BOOTSTRAP_GENERATION_EXPIRED',
        message: 'Bootstrap generation expired before completion.',
      });
    }
  }

  private assertContext(
    principal: AuthenticatedPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'BOOTSTRAP_NOT_ALLOWED',
        message: 'Bootstrap is not allowed.',
      });
    }
  }

  private validationError(): BadRequestException {
    return new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
    });
  }

  private licenseUnavailable(): ForbiddenException {
    return new ForbiddenException({
      code: 'BOOTSTRAP_NOT_AVAILABLE',
      message: 'Bootstrap is not available.',
    });
  }

  private translateStartError(error: unknown): never {
    if (
      error instanceof BadRequestException ||
      error instanceof ForbiddenException ||
      error instanceof GoneException
    ) {
      throw error;
    }
    const code = databaseErrorCode(error);
    if (code === '22023') throw this.validationError();
    if (code === '42501') throw this.licenseUnavailable();
    throw error;
  }
}
