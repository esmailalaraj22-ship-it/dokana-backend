export type BootstrapJsonPrimitive = null | boolean | number | string;
export type BootstrapJsonValue =
  BootstrapJsonPrimitive | BootstrapJsonValue[] | { [key: string]: BootstrapJsonValue };
export type BootstrapRecord = Record<string, BootstrapJsonValue>;

export interface BootstrapBoundary {
  contractVersion: number;
  baseWatermark: string;
  snapshotId: string;
  serverTime: Date;
}

export interface BootstrapDatasetManifest {
  id: string;
  order: number;
  recordCount: number;
  pageCount: number;
  checksum: string;
}

export interface BootstrapActivationContract {
  stagingModel: 'separate_sqlite_database';
  validation: readonly ['page_checksums', 'dataset_checksums', 'manifest_checksum', 'foreign_keys'];
  activation: 'atomic_database_swap_with_base_cursor';
  incompleteBootstrap: 'must_not_activate';
}

export interface BootstrapManifestCore {
  bootstrapVersion: 1;
  protocolVersion: 1;
  changeFeedVersion: 1;
  sqliteSchemaVersion: 10300;
  sessionId: string;
  datasetId: string;
  bootstrapGenerationId: string;
  storeId: string;
  deviceId: string;
  status: 'ready';
  serverTime: string;
  expiresAt: string;
  snapshotId: string;
  baseCursor: string;
  pageSize: number;
  encoding: {
    bigInteger: 'decimal_string';
    quantity: 'integer_milli_units_as_decimal_string';
    money: 'integer_minor_units_as_decimal_string';
    timestamp: 'rfc3339_utc';
  };
  activationContract: BootstrapActivationContract;
  datasets: BootstrapDatasetManifest[];
}

export interface BootstrapManifest extends BootstrapManifestCore {
  manifestChecksum: string;
}

export interface BootstrapPageCore {
  bootstrapVersion: 1;
  sessionId: string;
  snapshotId: string;
  datasetId: string;
  pageNumber: number;
  recordCount: number;
  records: BootstrapRecord[];
}

export interface BootstrapPage extends BootstrapPageCore {
  checksum: string;
}

export interface BootstrapStartCommand {
  bootstrapVersion: number;
  licenseId: string;
}

export interface BootstrapDatasetDefinition {
  id: string;
  relation: string;
  scope: 'store' | 'store-root' | 'current-device';
  orderBy: string;
  omittedFields?: readonly string[];
}
