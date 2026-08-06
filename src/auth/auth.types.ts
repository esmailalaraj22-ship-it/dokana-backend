export type UserStatus = 'active' | 'disabled' | 'locked' | 'deleted';
export type StoreStatus = 'active' | 'read_only' | 'suspended' | 'archived';
export type MembershipRole = 'owner' | 'manager' | 'viewer' | 'support';
export type DevicePlatform = 'android' | 'ios';

export interface CredentialRecord {
  userId: string;
  passwordHash: string;
  userStatus: UserStatus;
}

export interface AuthorizedStore {
  storeId: string;
  storeName: string;
  currencyCode: string;
  storeStatus: StoreStatus;
  membershipRole: MembershipRole;
  membershipVersion: string;
}

export interface AuthenticatedPrincipal {
  userId: string;
  email: string;
  fullName: string;
  storeId: string;
  storeName: string;
  storeStatus: Extract<StoreStatus, 'active' | 'read_only'>;
  membershipRole: MembershipRole;
  membershipVersion: string;
  deviceId: string;
  sessionId: string;
  sessionExpiresAt: Date;
}

export interface SessionIssueInput {
  userId: string;
  storeId: string;
  deviceId: string;
  deviceName: string;
  devicePlatform: DevicePlatform;
  sessionId: string;
  accessTokenJti: string;
  refreshTokenId: string;
  refreshTokenHash: string;
  refreshFamilyId: string;
  sessionExpiresAt: Date;
  refreshExpiresAt: Date;
  ipHash?: string;
  userAgentHash?: string;
}

export interface RefreshRotationInput {
  currentTokenHash: string;
  newTokenId: string;
  newTokenHash: string;
  newAccessTokenJti: string;
  refreshTtlSeconds: number;
}

export interface RefreshRotationResult {
  outcome: 'rotated' | 'invalid' | 'reused';
  userId: string | null;
  email: string | null;
  fullName: string | null;
  storeId: string | null;
  storeName: string | null;
  storeStatus: StoreStatus | null;
  membershipRole: MembershipRole | null;
  membershipVersion: string | null;
  deviceId: string | null;
  sessionId: string | null;
  sessionExpiresAt: Date | null;
}

export interface VerifiedAccessToken {
  userId: string;
  sessionId: string;
  storeId: string;
  deviceId: string;
  tokenId: string;
  expiresAt: number;
}

export interface AuthenticationResponse {
  tokenType: 'Bearer';
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  sessionExpiresAt: string;
  identity: {
    id: string;
    email: string;
    fullName: string;
  };
  store: {
    id: string;
    name: string;
    status: Extract<StoreStatus, 'active' | 'read_only'>;
  };
  membership: {
    role: MembershipRole;
    version: string;
  };
  deviceId: string;
  sessionId: string;
}
