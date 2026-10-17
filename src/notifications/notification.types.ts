import type { NotificationSeverity, NotificationType } from '../database/schema';

export type NotificationLifecycle = 'active' | 'resolved';

export interface NotificationCause {
  key: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  entityType: string;
  entityId: string;
}

export interface NotificationListAnchor {
  createdAt: Date;
  id: string;
}

export interface NotificationListCriteria {
  lifecycle: NotificationLifecycle | null;
  read: boolean | null;
  type: NotificationType | null;
  limit: number;
  anchor: NotificationListAnchor | null;
}

export interface NotificationListRow {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  resolvedAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationItem {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  subject: { type: string; id: string } | null;
  lifecycle: NotificationLifecycle;
  read: boolean;
  readAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationListResponse {
  items: NotificationItem[];
  nextCursor: string | null;
}

export interface NotificationReadStateResponse {
  id: string;
  read: boolean;
  readAt: string | null;
}

export interface NotificationSettingsResponse {
  customerDebtAmountAlertMinor: string;
  debtAgeAlertDays: number;
  lowStockAlertEnabled: boolean;
  version: string;
  updatedAt: string;
}

export interface NotificationSettingsMutationResponse extends NotificationSettingsResponse {
  operationId: string;
}
