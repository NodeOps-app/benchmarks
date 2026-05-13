import pLimit from 'p-limit';
import type { BurstProviderConfig, SandboxResult, SandboxResultStatus, ProgressStats } from './types.js';

export interface RunnerCallbacks {
  onResult: (result: SandboxResult) => Promise<void> | void;
  onProgress: (stats: ProgressStats) => void;
}

/**
 * Issue `config.concurrencyTarget` sandbox-creation requests against `compute`,
 * spreading task starts linearly over `config.rampSeconds` (provider-side overload
 * artefacts swamp the signal at true t=0 starts).
 *
 * Each task records a per-request latency; on failure, classifies the error.
 * Sandbox.destroy() is fire-and-forget after the latency is recorded, so it
 * doesn't pollute the measurement.
 */
export async function runBurst(
  config: BurstProviderConfig,
  compute: any,
  callbacks: RunnerCallbacks,
): Promise<void> {
  const { concurrencyTarget, rampSeconds, sandboxOptions, perRequestTimeoutMs = 120_000 } = config;
  const limit = pLimit(concurrencyTarget);

  let done = 0;
  let in_flight = 0;
  let errors = 0;
  const startTime = Date.now();

  const tasks: Promise<void>[] = [];
  for (let idx = 0; idx < concurrencyTarget; idx++) {
    const rampDelayMs = Math.floor((idx / concurrencyTarget) * rampSeconds * 1000);

    tasks.push(limit(async () => {
      const waitMs = rampDelayMs - (Date.now() - startTime);
      if (waitMs > 0) await sleep(waitMs);

      in_flight++;
      const started_at = new Date().toISOString();
      const t0 = performance.now();

      const result: SandboxResult = {
        sandbox_idx: idx,
        started_at,
        completed_at: '',
        latency_ms: 0,
        status: 'ok',
        http_status: null,
        error_code: null,
        error_message: null,
      };

      let sandbox: any = null;
      try {
        sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), perRequestTimeoutMs);
      } catch (err: any) {
        errors++;
        result.status = classifyError(err);
        result.http_status = numericHttpStatus(err);
        result.error_code = err?.code ?? null;
        result.error_message = truncate(err?.message ?? String(err), 500);
      } finally {
        result.latency_ms = Math.round(performance.now() - t0);
        result.completed_at = new Date().toISOString();
        in_flight--;
        done++;
        try { await callbacks.onResult(result); } catch (e) { /* swallow */ }
        callbacks.onProgress({ done, in_flight, errors });

        // Fire-and-forget destroy. The sandbox auto-destroys on its own
        // timeoutMs too; this is just a courtesy cleanup.
        if (sandbox?.destroy) {
          Promise.resolve(sandbox.destroy()).catch(() => {});
        }
      }
    }));
  }

  await Promise.all(tasks);
}

function classifyError(err: any): SandboxResultStatus {
  const msg = (err?.message ?? '').toString().toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (typeof (err?.status ?? err?.statusCode) === 'number') return 'http_error';
  return 'network_error';
}

function numericHttpStatus(err: any): number | null {
  const s = err?.status ?? err?.statusCode;
  return typeof s === 'number' ? s : null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
