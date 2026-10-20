import type { RecoveryStorageConfig } from './recovery-config';
import {
  UnavailableRecoveryArtifactStorage,
  type RecoveryArtifactStoragePort,
} from './recovery-artifact-storage.port';
import { FilesystemRecoveryArtifactStorage } from './filesystem-recovery-artifact-storage';
import { S3RecoveryArtifactStorage } from './s3-recovery-artifact-storage';

export function createRecoveryArtifactStorage(
  config: RecoveryStorageConfig,
): RecoveryArtifactStoragePort {
  if (config.driver === 'filesystem') {
    return new FilesystemRecoveryArtifactStorage(config.rootDirectory);
  }
  if (config.driver === 's3') return new S3RecoveryArtifactStorage(config);
  return new UnavailableRecoveryArtifactStorage();
}
