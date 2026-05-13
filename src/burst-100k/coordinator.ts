import { config as loadDotenv } from 'dotenv';
import * as fs from 'node:fs';
import { getProvider } from './providers.js';
import { PostgresSink } from './sinks/postgres.js';
import { TigrisSink } from './sinks/tigris.js';
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
  const TIGRIS_STORAGE_ENDPOINT = required('TIGRIS_STORAGE_ENDPOINT');
  const TIGRIS_STORAGE_BUCKET = required('TIGRIS_STORAGE_BUCKET');
  const TIGRIS_STORAGE_ACCESS_KEY_ID = required('TIGRIS_STORAGE_ACCESS_KEY_ID');
  const TIGRIS_STORAGE_SECRET_ACCESS_KEY = required('TIGRIS_STORAGE_SECRET_ACCESS_KEY');

  const commit_sha = process.env.GITHUB_SHA ?? 'local';
  const instance_id = process.env.INSTANCE_ID ?? 'local';
  const tigris_prefix = `s3://${TIGRIS_STORAGE_BUCKET}/${RUN_ID}/`;

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
  await pg.bootstrap(PROVIDER, commit_sha, instance_id, tigris_prefix);

  const tigris = new TigrisSink(
    {
      endpoint: TIGRIS_STORAGE_ENDPOINT,
      bucket: TIGRIS_STORAGE_BUCKET,
      accessKeyId: TIGRIS_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: TIGRIS_STORAGE_SECRET_ACCESS_KEY,
    },
    RUN_ID,
  );

  let lastStats: ProgressStats = { done: 0, in_flight: 0, errors: 0 };
  const latencies: number[] = [];

  // Periodically upload the coordinator's own stdout/stderr (redirected to a
  // file by launch.sh) to Tigris. Skipped silently when the env var is
  // unset (e.g. local `npm run bench:burst-100k:local` runs).
  const COORDINATOR_LOG_PATH = process.env.COORDINATOR_LOG_PATH;
  const uploadLog = async (): Promise<void> => {
    if (!COORDINATOR_LOG_PATH) return;
    try {
      const content = await fs.promises.readFile(COORDINATOR_LOG_PATH, 'utf-8');
      await tigris.writeLog(content);
    } catch (err: any) {
      console.error('[log-upload]', err?.message ?? err);
    }
  };

  const heartbeat = setInterval(() => {
    const ts = new Date().toISOString();
    pg.heartbeat(lastStats).catch(err => console.error('[heartbeat:pg]', err.message));
    tigris.writeHeartbeat({ ...lastStats, ts }).catch(err => console.error('[heartbeat:tigris]', err.message));
    uploadLog();
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
      await tigris.close();
      await pg.fail(`Process received ${signal} at done=${lastStats.done}/${provider.concurrencyTarget}`);
      await pg.close();
      await uploadLog();
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
        tigris.writeResult(result);
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
    await tigris.close();
    await tigris.writeMeta({ ...final, run_id: RUN_ID, provider: PROVIDER, ended_at: new Date().toISOString() });
    await pg.complete(final);
    await pg.close();

    console.log('[coordinator] run complete:', final);
    // Final log upload AFTER the completion message so it ends up in Tigris.
    await uploadLog();
  } catch (err: any) {
    clearInterval(heartbeat);
    console.error('[coordinator] run failed:', err?.message ?? err);
    try {
      await pg.flush();
      await tigris.close();
      await pg.fail(err?.message ?? String(err));
      await pg.close();
      await uploadLog();
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
