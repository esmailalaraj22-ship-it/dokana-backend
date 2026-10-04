import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { parseOfflineLicensePayload } from './offline-license-crypto';
import type {
  OfflineLicenseAdminListRecord,
  OfflineLicenseDatabaseRecord,
  OfflineLicenseRevocationRecord,
  OfflineLicenseValidationRecord,
  PreparedOfflineLicenseIssuance,
  PreparedOfflineLicenseRecord,
  PreparedOfflineLicenseRevocation,
} from './offline-license.types';

interface LicenseDatabaseRow {
  licenseId: string;
  signedPayload: unknown;
  signature: string;
  keyId: string;
  issuedAt: Date | string;
  expiresAt: Date | string;
  replayed: boolean;
  requiresSignature?: boolean;
}

interface LicenseValidationDatabaseRow extends LicenseDatabaseRow {
  deviceId: string;
  subscriptionId: string;
  revokedAt: Date | string | null;
  revokeReason: string | null;
}

interface LicenseAdminDatabaseRow {
  checkedAt: Date | string;
  licenseId: string;
  deviceId: string;
  subscriptionId: string;
  keyId: string;
  issuedAt: Date | string;
  expiresAt: Date | string;
  revokedAt: Date | string | null;
  revokeReason: string | null;
  licenseStatus: OfflineLicenseAdminListRecord['status'];
}

interface LicenseRevocationDatabaseRow {
  licenseId: string;
  revokedAt: Date | string;
  revokeReason: string;
  replayed: boolean;
}

function requiredDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error('Offline License authority returned invalid time.');
  return date;
}

function nullableDate(value: Date | string | null): Date | null {
  return value === null ? null : requiredDate(value);
}

function mapLicense(row: LicenseDatabaseRow): OfflineLicenseDatabaseRecord {
  return {
    licenseId: row.licenseId,
    signedPayload: parseOfflineLicensePayload(row.signedPayload),
    signature: row.signature,
    keyId: row.keyId,
    issuedAt: requiredDate(row.issuedAt),
    expiresAt: requiredDate(row.expiresAt),
    replayed: row.replayed,
  };
}

@Injectable()
export class OfflineLicenseRepository {
  async prepare(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedOfflineLicenseIssuance,
  ): Promise<PreparedOfflineLicenseRecord> {
    const result = await transaction.execute(sql`
      select
        license_id as "licenseId",
        signed_payload as "signedPayload",
        signature,
        key_id as "keyId",
        issued_at as "issuedAt",
        expires_at as "expiresAt",
        replayed,
        requires_signature as "requiresSignature"
      from ledger.prepare_offline_license(
        ${context.storeId}::uuid,
        ${context.deviceId}::uuid,
        ${input.licenseId}::uuid,
        ${input.operationId}::uuid,
        ${input.requestHash}::text,
        ${input.keyId}::text
      )
    `);
    const row = result.rows[0] as LicenseDatabaseRow | undefined;
    if (!row || typeof row.requiresSignature !== 'boolean') {
      throw new Error('Offline License preparation returned no result.');
    }
    return { ...mapLicense(row), requiresSignature: row.requiresSignature };
  }

  async complete(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: PreparedOfflineLicenseIssuance,
    signature: string,
  ): Promise<OfflineLicenseDatabaseRecord> {
    const result = await transaction.execute(sql`
      select
        license_id as "licenseId",
        signed_payload as "signedPayload",
        signature,
        key_id as "keyId",
        issued_at as "issuedAt",
        expires_at as "expiresAt",
        replayed
      from ledger.complete_offline_license(
        ${context.storeId}::uuid,
        ${input.licenseId}::uuid,
        ${input.operationId}::uuid,
        ${input.requestHash}::text,
        ${signature}::text
      )
    `);
    const row = result.rows[0] as LicenseDatabaseRow | undefined;
    if (!row) throw new Error('Offline License completion returned no result.');
    return mapLicense(row);
  }

  async readForValidation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    licenseId: string,
  ): Promise<OfflineLicenseValidationRecord | undefined> {
    const result = await transaction.execute(sql`
      select
        license_id as "licenseId",
        device_id as "deviceId",
        subscription_id as "subscriptionId",
        signed_payload as "signedPayload",
        signature,
        key_id as "keyId",
        issued_at as "issuedAt",
        expires_at as "expiresAt",
        revoked_at as "revokedAt",
        revoke_reason as "revokeReason",
        false as replayed
      from ledger.read_offline_license_for_validation(
        ${context.storeId}::uuid,
        ${context.deviceId}::uuid,
        ${licenseId}::uuid
      )
    `);
    const row = result.rows[0] as LicenseValidationDatabaseRow | undefined;
    if (!row) return undefined;
    return {
      ...mapLicense(row),
      deviceId: row.deviceId,
      subscriptionId: row.subscriptionId,
      revokedAt: nullableDate(row.revokedAt),
      revokeReason: row.revokeReason,
    };
  }

  async listAdmin(
    transaction: DatabaseTransaction,
    storeId: string,
    limit: number,
  ): Promise<OfflineLicenseAdminListRecord[]> {
    const result = await transaction.execute(sql`
      select
        checked_at as "checkedAt",
        license_id as "licenseId",
        device_id as "deviceId",
        subscription_id as "subscriptionId",
        key_id as "keyId",
        issued_at as "issuedAt",
        expires_at as "expiresAt",
        revoked_at as "revokedAt",
        revoke_reason as "revokeReason",
        license_status as "licenseStatus"
      from ledger.list_offline_licenses(${storeId}::uuid, ${limit}::integer)
    `);
    return (result.rows as unknown as LicenseAdminDatabaseRow[]).map((row) => ({
      checkedAt: requiredDate(row.checkedAt),
      licenseId: row.licenseId,
      deviceId: row.deviceId,
      subscriptionId: row.subscriptionId,
      keyId: row.keyId,
      issuedAt: requiredDate(row.issuedAt),
      expiresAt: requiredDate(row.expiresAt),
      revokedAt: nullableDate(row.revokedAt),
      revokeReason: row.revokeReason,
      status: row.licenseStatus,
    }));
  }

  async revoke(
    transaction: DatabaseTransaction,
    storeId: string,
    input: PreparedOfflineLicenseRevocation,
  ): Promise<OfflineLicenseRevocationRecord> {
    const result = await transaction.execute(sql`
      select
        license_id as "licenseId",
        revoked_at as "revokedAt",
        revoke_reason as "revokeReason",
        replayed
      from ledger.revoke_offline_license(
        ${storeId}::uuid,
        ${input.licenseId}::uuid,
        ${input.operationId}::uuid,
        ${input.requestHash}::text,
        ${input.reason}::text
      )
    `);
    const row = result.rows[0] as LicenseRevocationDatabaseRow | undefined;
    if (!row) throw new Error('Offline License revocation returned no result.');
    return {
      licenseId: row.licenseId,
      revokedAt: requiredDate(row.revokedAt),
      revokeReason: row.revokeReason,
      replayed: row.replayed,
    };
  }
}
