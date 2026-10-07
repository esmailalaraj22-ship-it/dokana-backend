import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { bootstrapChecksum, canonicalBootstrapJson } from './bootstrap-canonical-json';
import type {
  BootstrapJsonValue,
  BootstrapManifest,
  BootstrapManifestCore,
  BootstrapPage,
  BootstrapPageCore,
} from './bootstrap.types';

export const BOOTSTRAP_ARTIFACT_ROOT = Symbol('BOOTSTRAP_ARTIFACT_ROOT');

export class BootstrapArtifactNotFoundError extends Error {
  constructor() {
    super('Bootstrap artifact not found.');
    this.name = 'BootstrapArtifactNotFoundError';
  }
}

export class BootstrapArtifactExpiredError extends Error {
  constructor() {
    super('Bootstrap artifact expired.');
    this.name = 'BootstrapArtifactExpiredError';
  }
}

export class BootstrapArtifactIntegrityError extends Error {
  constructor() {
    super('Bootstrap artifact integrity validation failed.');
    this.name = 'BootstrapArtifactIntegrityError';
  }
}

function artifactJson(value: unknown): string {
  return canonicalBootstrapJson(value as BootstrapJsonValue);
}

function pageFileName(datasetId: string, pageNumber: number): string {
  return `${datasetId}.${pageNumber.toString().padStart(8, '0')}.json`;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDatasetManifest(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    Number.isSafeInteger(value.order) &&
    Number.isSafeInteger(value.recordCount) &&
    Number.isSafeInteger(value.pageCount) &&
    typeof value.checksum === 'string'
  );
}

export class BootstrapArtifactWriter {
  constructor(
    private readonly stagingDirectory: string,
    private readonly readyDirectory: string,
  ) {}

  async writePage(core: BootstrapPageCore): Promise<BootstrapPage> {
    const page: BootstrapPage = {
      ...core,
      checksum: bootstrapChecksum(core as unknown as BootstrapJsonValue),
    };
    await writeFile(
      join(this.stagingDirectory, pageFileName(core.datasetId, core.pageNumber)),
      artifactJson(page),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    return page;
  }

  async finalize(core: BootstrapManifestCore): Promise<BootstrapManifest> {
    const manifest: BootstrapManifest = {
      ...core,
      manifestChecksum: bootstrapChecksum(core as unknown as BootstrapJsonValue),
    };
    await writeFile(join(this.stagingDirectory, 'manifest.json'), artifactJson(manifest), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(this.stagingDirectory, this.readyDirectory);
    return manifest;
  }

  async abort(): Promise<void> {
    await rm(this.stagingDirectory, { recursive: true, force: true });
  }
}

@Injectable()
export class BootstrapArtifactStore {
  constructor(@Inject(BOOTSTRAP_ARTIFACT_ROOT) private readonly rootDirectory: string) {}

  async begin(sessionId: string): Promise<BootstrapArtifactWriter> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const stagingDirectory = join(this.rootDirectory, `.creating-${sessionId}`);
    const readyDirectory = join(this.rootDirectory, sessionId);
    await rm(stagingDirectory, { recursive: true, force: true });
    await mkdir(stagingDirectory, { mode: 0o700 });
    return new BootstrapArtifactWriter(stagingDirectory, readyDirectory);
  }

  async readManifest(sessionId: string): Promise<BootstrapManifest> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(join(this.rootDirectory, sessionId, 'manifest.json'), 'utf8'),
      );
    } catch {
      throw new BootstrapArtifactNotFoundError();
    }
    if (!isJsonRecord(parsed)) {
      throw new BootstrapArtifactIntegrityError();
    }
    const manifestRecord = parsed;
    const { manifestChecksum, ...core } = manifestRecord;
    const expiresAt =
      typeof manifestRecord.expiresAt === 'string'
        ? Date.parse(manifestRecord.expiresAt)
        : Number.NaN;
    if (
      typeof manifestChecksum !== 'string' ||
      bootstrapChecksum(core as unknown as BootstrapJsonValue) !== manifestChecksum ||
      manifestRecord.sessionId !== sessionId ||
      manifestRecord.status !== 'ready' ||
      !Number.isFinite(expiresAt) ||
      !Array.isArray(manifestRecord.datasets) ||
      !manifestRecord.datasets.every(isDatasetManifest)
    ) {
      throw new BootstrapArtifactIntegrityError();
    }
    if (expiresAt <= Date.now()) {
      throw new BootstrapArtifactExpiredError();
    }
    return parsed as unknown as BootstrapManifest;
  }

  async readPage(
    manifest: BootstrapManifest,
    datasetId: string,
    pageNumber: number,
  ): Promise<BootstrapPage> {
    const dataset = manifest.datasets.find((candidate) => candidate.id === datasetId);
    if (!dataset || pageNumber < 1 || pageNumber > dataset.pageCount) {
      throw new BootstrapArtifactNotFoundError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(
          join(this.rootDirectory, manifest.sessionId, pageFileName(datasetId, pageNumber)),
          'utf8',
        ),
      );
    } catch {
      throw new BootstrapArtifactNotFoundError();
    }
    if (!isJsonRecord(parsed)) {
      throw new BootstrapArtifactIntegrityError();
    }
    const pageRecord = parsed;
    const { checksum, ...core } = pageRecord;
    if (
      typeof checksum !== 'string' ||
      bootstrapChecksum(core as unknown as BootstrapJsonValue) !== checksum ||
      pageRecord.bootstrapVersion !== manifest.bootstrapVersion ||
      pageRecord.sessionId !== manifest.sessionId ||
      pageRecord.snapshotId !== manifest.snapshotId ||
      pageRecord.datasetId !== datasetId ||
      pageRecord.pageNumber !== pageNumber ||
      !Array.isArray(pageRecord.records) ||
      !pageRecord.records.every(isJsonRecord) ||
      pageRecord.recordCount !== pageRecord.records.length
    ) {
      throw new BootstrapArtifactIntegrityError();
    }
    return parsed as unknown as BootstrapPage;
  }
}
