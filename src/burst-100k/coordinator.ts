import { config as loadDotenv } from 'dotenv';
import { getProvider } from './providers.js';
import { PostgresSink } from './sinks/postgres.js';
import { R2Sink } from './sinks/r2.js';
import { runBurst } from './runner.js';
import type { ProgressStats } from './types.js';

// dotenv only matters for local invocation. In production the env is set by
// launch.sh via `nsc ssh ... export VAR=...`.
loadDotenv();

const HEARTBEAT_INTERVAL_MS = 30_000;

async function main() {
  const RUN_ID = required('RUN_ID');
  const PROVIDER = required('PROVIDER');
  const PG_URL = required('PG_URL');
  const R2_ENDPOINT = required('R2_ENDPOINT');
  const R2_BUCKET = required('R2_BUCKET');
  const R2_ACCESS_KEY_ID = required('R2_ACCESS_KEY_ID');
  const R2_SECRET_ACCESS_KEY = required('R2_SECRET_ACCESS_KEY');

  const commit_sha = process.env.GITHUB_SHA ?? 'local';
  const instance_id = process.env.INSTANCE_ID ?? 'local';
  const r2_prefix = `s3://${R2_BUCKET}/${RUN_ID}/`;

  const provider = getProvider(PROVIDER);

  // Allow env override of concurrencyTarget for local smoke tests.
  const override = process.env.CONCURRENCY_TARGET;
  if (override) {
    provider.concurrencyTarget = parseInt(override, 10);
    console.log(`[coordinator] override CONCURRENCY_TARGET=${provider.concurrencyTarget}`);
  }

  // Validate provider-specific requiredEnvVars
  const missing = provider.requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    const msg = `Missing required env vars for ${PROVIDER}: ${missing.join(', ')}`;
    console.error(`[coordinator] ${msg}`);
    await tryRecordFailure(PG_URL, RUN_ID, msg);
    process.exit(1);
  }

  console.log(`[coordinator] run_id=${RUN_ID} provider=${PROVIDER} concurrency=${provider.concurrencyTarget} ramp=${provider.rampSeconds}s`);

  const pg = new PostgresSink(PG_URL, RUN_ID);
  await pg.connect();
  await pg.bootstrap(PROVIDER, commit_sha, instance_id, r2_prefix);

  const r2 = new R2Sink(
    { endpoint: R2_ENDPOINT, bucket: R2_BUCKET, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    RUN_ID,
  );

  let lastStats: ProgressStats = { done: 0, in_flight: 0, errors: 0 };
  const latencies: number[] = [];

  const heartbeat = setInterval(() => {
    const ts = new Date().toISOString();
    pg.heartbeat(lastStats).catch(err => console.error('[heartbeat:pg]', err.message));
    r2.writeHeartbeat({ ...lastStats, ts }).catch(err => console.error('[heartbeat:r2]', err.message));
    console.log(`[heartbeat] done=${lastStats.done} in_flight=${lastStats.in_flight} errors=${lastStats.errors}`);
  }, HEARTBEAT_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[coordinator] ${signal} received; flushing...`);
    clearInterval(heartbeat);
    try {
      await pg.flush();
      await r2.close();
      await pg.fail(`Process received ${signal} at done=${lastStats.done}/${provider.concurrencyTarget}`);
      await pg.close();
    } catch (e: any) {
      console.error('[coordinator] shutdown flush failed:', e?.message ?? e);
    }
    process.exit(1);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const compute = provider.createCompute();

  try {
    await runBurst(provider, compute, {
      async onResult(result) {
        if (result.status === 'ok') latencies.push(result.latency_ms);
        r2.writeResult(result);
        await pg.write(result);
      },
      onProgress(stats) {
        lastStats = stats;
      },
    });

    clearInterval(heartbeat);

    latencies.sort((a, b) => a - b);
    const pct = (q: number) =>
      latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];

    const final = {
      sandboxes_attempted: provider.concurrencyTarget,
      sandboxes_succeeded: latencies.length,
      p50_latency_ms: pct(0.5),
      p99_latency_ms: pct(0.99),
    };

    await pg.flush();
    await r2.close();
    await r2.writeMeta({ ...final, run_id: RUN_ID, provider: PROVIDER, ended_at: new Date().toISOString() });
    await pg.complete(final);
    await pg.close();

    console.log('[coordinator] run complete:', final);
  } catch (err: any) {
    clearInterval(heartbeat);
    console.error('[coordinator] run failed:', err?.message ?? err);
    try {
      await pg.flush();
      await r2.close();
      await pg.fail(err?.message ?? String(err));
      await pg.close();
    } catch (e: any) {
      console.error('[coordinator] failed to record failure:', e?.message ?? e);
    }
    process.exit(1);
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[coordinator] missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function tryRecordFailure(pgUrl: string, runId: string, message: string): Promise<void> {
  try {
    const pg = new PostgresSink(pgUrl, runId);
    await pg.connect();
    await pg.fail(message);
    await pg.close();
  } catch (e: any) {
    console.error('[coordinator] could not write failure row:', e?.message ?? e);
  }
}

main().catch(err => {
  console.error('[coordinator] crashed:', err);
  process.exit(1);
});
