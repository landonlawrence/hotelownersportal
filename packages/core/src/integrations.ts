/**
 * Integration interfaces for future PMS, accounting and Travera connections.
 *
 * Nothing here assumes an external API exists or that access has been granted.
 * Concrete adapters must be implemented against vendor documentation and real
 * credentials supplied through AWS Secrets Manager (never the browser), and must
 * emit records in the same shapes as the standardized import formats so they go
 * through identical validation, idempotency and lineage handling.
 */
import type { DailyPerformanceImportRecord } from './ingestion/dailyPerformance.js';
import type { MonthlyActualImportRecord } from './ingestion/monthlyActuals.js';
import type { ValidationIssue } from './ingestion/types.js';

export type IntegrationKind = 'pms' | 'accounting' | 'travera';

export interface IntegrationConnectionConfig {
  connectionId: string;
  companyId: string;
  kind: IntegrationKind;
  provider: string;
  /** ARN / name of the secret holding credentials. Resolved server side only. */
  secretRef: string | null;
  /** Non-secret settings (e.g. external property ids). */
  settings: Record<string, unknown>;
}

export interface PullWindow {
  from: string;
  to: string;
}

export interface PullResult<T> {
  records: T[];
  issues: ValidationIssue[];
  /** Opaque cursor for incremental pulls. */
  cursor?: string;
  /** Raw payload persisted as the source file for lineage. */
  rawPayload: Uint8Array;
  rawContentType: string;
}

export interface PmsAdapter {
  readonly provider: string;
  testConnection(cfg: IntegrationConnectionConfig): Promise<{ ok: boolean; message: string }>;
  pullDailyPerformance(cfg: IntegrationConnectionConfig, window: PullWindow): Promise<PullResult<Omit<DailyPerformanceImportRecord, 'sourceRow'>>>;
}

export interface AccountingAdapter {
  readonly provider: string;
  testConnection(cfg: IntegrationConnectionConfig): Promise<{ ok: boolean; message: string }>;
  pullMonthlyActuals(cfg: IntegrationConnectionConfig, periodMonth: string): Promise<PullResult<Omit<MonthlyActualImportRecord, 'sourceRow' | 'accountId'>>>;
}

/**
 * Travera is a future upstream data source. The portal is standalone and must
 * keep working when Travera is unavailable, so the adapter is optional and
 * pull-based; no endpoints are assumed.
 */
export interface TraveraAdapter {
  readonly provider: 'travera';
  testConnection(cfg: IntegrationConnectionConfig): Promise<{ ok: boolean; message: string }>;
  pullDailyPerformance?(cfg: IntegrationConnectionConfig, window: PullWindow): Promise<PullResult<Omit<DailyPerformanceImportRecord, 'sourceRow'>>>;
  pullMonthlyActuals?(cfg: IntegrationConnectionConfig, periodMonth: string): Promise<PullResult<Omit<MonthlyActualImportRecord, 'sourceRow' | 'accountId'>>>;
}

export class IntegrationNotConfiguredError extends Error {
  constructor(kind: IntegrationKind, provider: string) {
    super(`${kind} integration "${provider}" is not configured. No adapter has been implemented or authorised.`);
  }
}

const adapters = new Map<string, PmsAdapter | AccountingAdapter | TraveraAdapter>();

export function registerAdapter(kind: IntegrationKind, adapter: PmsAdapter | AccountingAdapter | TraveraAdapter): void {
  adapters.set(`${kind}:${adapter.provider}`, adapter);
}

export function getAdapter(kind: IntegrationKind, provider: string): PmsAdapter | AccountingAdapter | TraveraAdapter {
  const a = adapters.get(`${kind}:${provider}`);
  if (!a) throw new IntegrationNotConfiguredError(kind, provider);
  return a;
}
