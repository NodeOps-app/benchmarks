import type { ProviderConfig } from '../sandbox/types.js';

export interface BurstProviderConfig extends ProviderConfig {
  /** Peak target concurrency for this provider's burst (typically 100_000). */
  concurrencyTarget: number;
  /** Ramp from 0 to concurrencyTarget over this many seconds. */
  rampSeconds: number;
  /** Per-request timeout in ms. Defaults to 120_000. */
  perRequestTimeoutMs?: number;
}

export type SandboxResultStatus = 'ok' | 'timeout' | 'http_error' | 'network_error';

export interface SandboxResult {
  sandbox_idx: number;
  started_at: string;        // ISO-8601
  completed_at: string;      // ISO-8601
  latency_ms: number;
  status: SandboxResultStatus;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
}

export interface ProgressStats {
  done: number;
  in_flight: number;
  errors: number;
}

export interface FinalStats {
  sandboxes_attempted: number;
  sandboxes_succeeded: number;
  p50_latency_ms: number;
  p99_latency_ms: number;
}
