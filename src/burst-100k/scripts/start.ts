#!/usr/bin/env node
/**
 * Launcher for the burst-100k benchmark.
 *
 * Spreads a single logical burst of N sandboxes across K Namespace VMs by
 * provisioning K VMs in parallel — each with CONCURRENCY_TARGET = N/K, tagged
 * with a shared GROUP_ID + per-VM SHARD_INDEX. A single-VM run is just
 * `--vms 1` (the default). Each VM provisions, uploads the coordinator bundle,
 * records its run in Postgres, and starts the coordinator detached; this script
 * lives for ~30s while the multi-hour benchmark continues on the VMs.
 *
 * Each VM ends up as its own `runs` row in Postgres; combine shards after the
 * fact with:
 *
 *   tsx src/burst-100k/scripts/aggregate.ts --group <GROUP_ID>
 *
 * Usage:
 *   tsx src/burst-100k/scripts/start.ts --provider e2b --total 100000 --vms 20
 *   tsx src/burst-100k/scripts/start.ts -p e2b -t 100000 -v 20 --duration 2h
 *   tsx src/burst-100k/scripts/start.ts -p e2b -t 1000 -v 1   # single VM
 *   npm run bench:burst-100k:start -- --provider e2b --total 100000 --vms 20
 *
 * Required env:
 *   PG_URL                            Neon connection string
 *   TIGRIS_STORAGE_ENDPOINT, _BUCKET  Tigris (S3-compat) target for raw results
 *   TIGRIS_STORAGE_ACCESS_KEY_ID
 *   TIGRIS_STORAGE_SECRET_ACCESS_KEY
 *   Provider-specific keys            e.g. E2B_API_KEY (validated by coordinator)
 *
 * Optional env:
 *   GITHUB_SHA                Defaults to `git rev-parse HEAD` or "local"
 */

import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is <repo>/src/burst-100k/scripts; the project root (cwd for npm,
// psql, and the dist/ + db/ paths below) is three levels up.
const repoRoot = path.resolve(__dirname, '../../..');

// Provider-specific credentials forwarded to the VM. The coordinator's
// `requiredEnvVars` check fails fast if its provider's vars are missing, so we
// just forward whatever is present in this process's env.
const PROVIDER_SECRET_VARS = [
  'E2B_API_KEY', 'MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET', 'DAYTONA_API_KEY',
  'CSB_API_KEY', 'RUNLOOP_API_KEY', 'TENSORLAKE_API_KEY', 'DECLAW_API_KEY',
  'VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID',
];

const MACHINE_TYPE_DEFAULT = '16x32';

// ----- helpers --------------------------------------------------------------

/**
 * POSIX single-quote escaping for embedding values in the `/root/start.sh`
 * body, which runs under BusyBox `sh` on the Wolfi `--bare` image. Wrap in
 * single quotes and replace each `'` with `'\''`. Replaces bash `printf '%q'`.
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

type Logger = (line: string) => void;

interface RunResult { code: number; stdout: string; }

/**
 * Async wrapper around `spawn` for `nsc` / `psql`. Streams stdout+stderr to
 * `log` line-by-line (so parallel shards stay readable) and optionally captures
 * stdout. Never rejects — resolves with the exit code so callers decide.
 */
function sh(
  cmd: string,
  args: string[],
  opts: { log: Logger; capture?: boolean; quiet?: boolean } = { log: () => {} },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: repoRoot });
    let stdout = '';
    let stderrBuf = '';
    let stdoutBuf = '';
    const onChunk = (buf: string, isErr: boolean): string => {
      if (opts.capture && !isErr) stdout += buf;
      let acc = buf;
      const lines = acc.split('\n');
      acc = lines.pop() ?? '';
      if (!opts.quiet) for (const line of lines) opts.log(line);
      return acc;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdoutBuf = onChunk(stdoutBuf + d, false); });
    child.stderr.on('data', (d: string) => { stderrBuf = onChunk(stderrBuf + d, true); });
    child.on('close', (code) => {
      if (!opts.quiet) {
        if (stdoutBuf) opts.log(stdoutBuf);
        if (stderrBuf) opts.log(stderrBuf);
      }
      resolve({ code: code ?? 1, stdout });
    });
    child.on('error', (err) => {
      opts.log(`spawn error (${cmd}): ${err.message}`);
      resolve({ code: 1, stdout });
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function shortSha(): string {
  try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return 'local'; }
}
function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// ----- CLI ------------------------------------------------------------------

interface Args {
  provider: string;
  total: number;
  vms: number;
  duration: string;
  machineType: string;
  groupId?: string;
}

function usage(): string {
  return [
    'Usage: tsx src/burst-100k/scripts/start.ts [options]',
    '',
    'Required:',
    '  --provider <name>, -p  Provider name (e2b, modal, runloop, ...)',
    '  --total <n>,    -t     Total concurrent sandboxes across all VMs',
    '',
    'Optional:',
    '  --vms <n>,      -v     Number of Namespace VMs to spread across',
    '                         (must divide --total evenly; default: 1)',
    `  --duration <dur>       Namespace VM lifetime (default: 1h)`,
    `  --machine-type <type>  Namespace machine type (default: ${MACHINE_TYPE_DEFAULT})`,
    '  --group-id <id>        Override the generated GROUP_ID',
    '  --help, -h             Print this help',
    '',
    'Examples:',
    '  npm run bench:burst-100k:start -- --provider e2b --total 100000 --vms 20',
    '  tsx src/burst-100k/scripts/start.ts -p e2b -t 1000 -v 1 --duration 30m',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Partial<Args> = { vms: 1, duration: '1h', machineType: MACHINE_TYPE_DEFAULT };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2); }
      return v;
    };
    if (a === '--provider' || a === '-p') out.provider = next();
    else if (a === '--total' || a === '-t') out.total = parseInt(next(), 10);
    else if (a === '--vms' || a === '-v') out.vms = parseInt(next(), 10);
    else if (a === '--duration') out.duration = next();
    else if (a === '--machine-type') out.machineType = next();
    else if (a === '--group-id') out.groupId = next();
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else { console.error(`unknown arg: ${a}\n${usage()}`); process.exit(2); }
  }
  if (!out.provider) { console.error(`--provider is required\n${usage()}`); process.exit(2); }
  if (!Number.isFinite(out.total) || (out.total as number) <= 0) {
    console.error(`--total must be a positive integer\n${usage()}`); process.exit(2);
  }
  if (!Number.isFinite(out.vms) || (out.vms as number) <= 0) {
    console.error(`--vms must be a positive integer\n${usage()}`); process.exit(2);
  }
  if ((out.total as number) % (out.vms as number) !== 0) {
    console.error(`--total (${out.total}) must be evenly divisible by --vms (${out.vms})`);
    process.exit(2);
  }
  return out as Args;
}

// ----- per-VM launch --------------------------------------------------------

interface ShardOpts {
  provider: string;
  runId: string;
  concurrencyTarget: number;
  duration: string;
  machineType: string;
  githubSha: string;
  // Sharded metadata; undefined for single-VM runs.
  groupId?: string;
  shardIndex?: number;
  shardCount?: number;
}

interface ShardResult { shard: number; runId: string; rc: number; }

/**
 * Build the `/root/start.sh` body executed on the VM. POSIX `sh` only (BusyBox
 * on Wolfi). Values are shell-quoted with shQuote so unusual characters in
 * secrets/URLs survive.
 */
function buildStartupScript(opts: ShardOpts, instanceId: string): string {
  const exports: string[] = [
    `export RUN_ID=${shQuote(opts.runId)}`,
    `export PROVIDER=${shQuote(opts.provider)}`,
    `export INSTANCE_ID=${shQuote(instanceId)}`,
    `export GITHUB_SHA=${shQuote(opts.githubSha)}`,
    `export PG_URL=${shQuote(process.env.PG_URL!)}`,
    `export TIGRIS_STORAGE_ENDPOINT=${shQuote(process.env.TIGRIS_STORAGE_ENDPOINT!)}`,
    `export TIGRIS_STORAGE_BUCKET=${shQuote(process.env.TIGRIS_STORAGE_BUCKET!)}`,
    `export TIGRIS_STORAGE_ACCESS_KEY_ID=${shQuote(process.env.TIGRIS_STORAGE_ACCESS_KEY_ID!)}`,
    `export TIGRIS_STORAGE_SECRET_ACCESS_KEY=${shQuote(process.env.TIGRIS_STORAGE_SECRET_ACCESS_KEY!)}`,
    // Where the coordinator reads its own process log for periodic Tigris
    // upload; we tee node's output here while keeping stdout for Namespace logs.
    `export COORDINATOR_LOG_PATH=/root/run.log`,
    `export CONCURRENCY_TARGET=${shQuote(String(opts.concurrencyTarget))}`,
  ];
  for (const v of PROVIDER_SECRET_VARS) {
    const val = process.env[v];
    if (val) exports.push(`export ${v}=${shQuote(val)}`);
  }
  if (opts.groupId !== undefined && opts.shardIndex !== undefined && opts.shardCount !== undefined) {
    exports.push(`export GROUP_ID=${shQuote(opts.groupId)}`);
    exports.push(`export SHARD_INDEX=${shQuote(String(opts.shardIndex))}`);
    exports.push(`export SHARD_COUNT=${shQuote(String(opts.shardCount))}`);
  }
  return [
    '#!/bin/sh',
    'set -e',
    ...exports,
    'ulimit -n 200000',
    // Detach and duplicate output: keep stdout/stderr for Namespace logs while
    // also writing /root/run.log for periodic Tigris upload. Wrap in `sh -c`
    // so nohup applies to the whole pipeline rather than only `node`.
    'nohup sh -c "node /root/coordinator.cjs 2>&1 | tee -a /root/run.log" </dev/null &',
    'rm -f -- "$0"   # self-destruct so creds never linger on disk',
    '',
  ].join('\n');
}

/**
 * Provision one Namespace VM and start the coordinator on it: create instance,
 * upload bundle, record the run in Postgres, install node, start the
 * coordinator detached, then confirm it's running. Never throws — resolves with
 * rc so a failed shard doesn't take down its siblings.
 */
async function launchOne(shard: number, opts: ShardOpts, log: Logger): Promise<ShardResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-100k-'));
  const cidFile = path.join(tmpDir, 'cid');
  const startFile = path.join(tmpDir, 'start.sh');
  let client: InstanceType<typeof Client> | null = null;
  try {
    // 1. provision instance
    log(`creating Namespace instance (machine=${opts.machineType} duration=${opts.duration})`);
    const create = await sh('nsc', [
      'create', '--bare',
      '--machine_type', opts.machineType,
      '--duration', opts.duration,
      '--cidfile', cidFile,
    ], { log });
    if (create.code !== 0 || !fs.existsSync(cidFile)) {
      log(`ERROR: nsc create failed (rc=${create.code})`);
      return { shard, runId: opts.runId, rc: 1 };
    }
    const instanceId = fs.readFileSync(cidFile, 'utf8').trim();
    log(`instance: ${instanceId}`);

    // 2. upload coordinator bundle
    log('uploading coordinator bundle');
    const up = await sh('nsc', [
      'instance', 'upload', instanceId, 'dist/burst-100k.cjs', '/root/coordinator.cjs',
    ], { log });
    if (up.code !== 0) { log(`ERROR: bundle upload failed (rc=${up.code})`); return { shard, runId: opts.runId, rc: 1 }; }

    // 3. record run in Postgres BEFORE handing off. The coordinator UPSERTs the
    // same row on startup; this INSERT exists so the run is recorded even if the
    // SSH hand-off below fails. Parameterized via pg so NULLs (absent sharded
    // metadata) and arbitrary values are handled natively. The connection is
    // kept open and reused for the confirmation poll in step 6.
    log('recording run in Postgres');
    client = new Client({ connectionString: process.env.PG_URL });
    try {
      await client.connect();
      await client.query(
        `INSERT INTO runs (id, provider, commit_sha, instance_id, started_at, status,
                           tigris_prefix, group_id, shard_index, shard_count)
         VALUES ($1, $2, $3, $4, now(), 'running', $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          opts.runId, opts.provider, opts.githubSha, instanceId,
          `s3://${process.env.TIGRIS_STORAGE_BUCKET}/${opts.runId}/`,
          opts.groupId ?? null, opts.shardIndex ?? null, opts.shardCount ?? null,
        ],
      );
    } catch (err) {
      log(`ERROR: runs INSERT failed: ${err instanceof Error ? err.message : String(err)}`);
      return { shard, runId: opts.runId, rc: 1 };
    }

    // 4. prepare VM: Wolfi --bare has no node, install it.
    log('installing nodejs on VM');
    const apk = await sh('nsc', ['ssh', instanceId, '--', 'apk', 'add', '-q', 'nodejs'], { log });
    if (apk.code !== 0) { log(`ERROR: apk add nodejs failed (rc=${apk.code})`); return { shard, runId: opts.runId, rc: 1 }; }

    // 5. upload + run the startup script (detaches the coordinator).
    fs.writeFileSync(startFile, buildStartupScript(opts, instanceId), { mode: 0o600 });
    log('starting coordinator detached');
    const upStart = await sh('nsc', ['instance', 'upload', instanceId, startFile, '/root/start.sh'], { log });
    if (upStart.code !== 0) { log(`ERROR: start.sh upload failed (rc=${upStart.code})`); return { shard, runId: opts.runId, rc: 1 }; }
    await sh('nsc', ['ssh', instanceId, '--', 'chmod', '600', '/root/start.sh'], { log });
    await sh('nsc', ['ssh', instanceId, '--', 'sh', '/root/start.sh'], { log });

    // 6. confirm the coordinator launched. Past failures silently left the VM
    // idle, so this is load-bearing. Two durable signals, because a small burst
    // can finish (and the node process exit) before `nsc ssh pgrep` even lands:
    //   - the runs row reaches a terminal status ('done' = ran to completion,
    //     'failed' = coordinator recorded a fatal error), or
    //   - the process is still alive (long bursts run for minutes).
    // Only a row still 'running' with no live process after the window is a
    // genuine never-started / idle-VM failure.
    let confirmed = false;
    for (let i = 1; i <= 12; i++) {
      const { rows } = await client.query<{ status: string; error_message: string | null }>(
        'SELECT status, error_message FROM runs WHERE id = $1', [opts.runId],
      );
      const status = rows[0]?.status;
      if (status === 'done') { log('coordinator completed (status=done)'); confirmed = true; break; }
      if (status === 'failed') {
        log(`ERROR: coordinator reported failure: ${rows[0]?.error_message ?? 'unknown'}`);
        await sh('nsc', ['ssh', instanceId, '--', 'tail', '-30', '/root/run.log'], { log });
        return { shard, runId: opts.runId, rc: 1 };
      }
      const alive = await sh('nsc', ['ssh', instanceId, '--', 'pgrep', '-f', 'coordinator.cjs'], { log, quiet: true });
      if (alive.code === 0) { log(`coordinator confirmed running on VM (after ${i})`); confirmed = true; break; }
      await sleep(1000);
    }
    if (!confirmed) {
      log('ERROR: coordinator not running and run not terminal after timeout; tail /root/run.log:');
      await sh('nsc', ['ssh', instanceId, '--', 'tail', '-30', '/root/run.log'], { log });
      return { shard, runId: opts.runId, rc: 1 };
    }

    log(`OK  run_id=${opts.runId}  instance=${instanceId}`);
    log(`  Tail logs:  nsc ssh ${instanceId} -- tail -f /root/run.log`);
    log(`  Stop:       nsc ssh ${instanceId} -- pkill -TERM node`);
    log(`  Destroy:    nsc destroy --force ${instanceId}`);
    return { shard, runId: opts.runId, rc: 0 };
  } catch (err) {
    log(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return { shard, runId: opts.runId, rc: 1 };
  } finally {
    if (client) await client.end().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ----- orchestration --------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const perVm = args.total / args.vms;
  const githubSha = process.env.GITHUB_SHA ?? shortSha();
  const sha8 = githubSha.slice(0, 8);
  const stamp = utcStamp();

  // GROUP_ID is shared across shards; suffix on each RUN_ID encodes position.
  const groupId = args.groupId ?? `${stamp}-${sha8}-${args.provider}-g${args.vms}x${perVm}`;
  const shardWidth = String(args.vms - 1).length;
  const pad = (n: number): string => String(n).padStart(shardWidth, '0');
  const runIds = Array.from({ length: args.vms }, (_, i) =>
    `${stamp}-${sha8}-${args.provider}-s${pad(i)}of${args.vms}`,
  );

  const rule = '═'.repeat(67);
  console.log(rule);
  console.log(' burst-100k :: launch');
  console.log(rule);
  console.log(`  provider:   ${args.provider}`);
  console.log(`  total:      ${args.total.toLocaleString()} sandboxes`);
  console.log(`  vms:        ${args.vms}`);
  console.log(`  per-vm:     ${perVm.toLocaleString()} sandboxes`);
  console.log(`  duration:   ${args.duration}`);
  console.log(`  machine:    ${args.machineType}`);
  console.log(`  group_id:   ${groupId}`);
  console.log('');

  if (!process.env.PG_URL) { console.error('PG_URL not set (check .env)'); process.exit(2); }
  for (const v of ['TIGRIS_STORAGE_ENDPOINT', 'TIGRIS_STORAGE_BUCKET', 'TIGRIS_STORAGE_ACCESS_KEY_ID', 'TIGRIS_STORAGE_SECRET_ACCESS_KEY']) {
    if (!process.env[v]) { console.error(`${v} not set (check .env)`); process.exit(2); }
  }

  // Bundle the coordinator ONCE up front (doing it once removes the race on
  // dist/burst-100k.cjs across parallel shards).
  console.log('[launch] bundling coordinator -> dist/burst-100k.cjs');
  const bundle = spawnSync('npm', ['run', '--silent', 'bundle:burst-100k'], { stdio: 'inherit', cwd: repoRoot });
  if (bundle.status !== 0) { console.error(`[launch] bundle failed (rc=${bundle.status}); aborting`); process.exit(bundle.status ?? 1); }

  // Apply the Postgres schema ONCE up front. `CREATE TABLE/INDEX IF NOT EXISTS`
  // is not race-safe under N parallel applies, so the orchestrator owns it.
  console.log('[launch] ensuring Postgres schema');
  const schema = spawnSync('psql', [process.env.PG_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'db/burst-100k.sql'], { stdio: 'inherit', cwd: repoRoot });
  if (schema.status !== 0) { console.error(`[launch] schema apply failed (rc=${schema.status}); aborting before any VMs are spawned`); process.exit(schema.status ?? 1); }
  console.log('');

  const sharded = args.vms > 1;
  console.log(`spawning ${args.vms} parallel launch(es)…\n`);
  const results = await Promise.all(
    Array.from({ length: args.vms }, (_, i) => {
      const tag = sharded ? `[s${pad(i)}] ` : '';
      const log: Logger = (line) => console.log(`${tag}${line}`);
      const opts: ShardOpts = {
        provider: args.provider,
        runId: runIds[i],
        concurrencyTarget: perVm,
        duration: args.duration,
        machineType: args.machineType,
        githubSha,
        ...(sharded ? { groupId, shardIndex: i, shardCount: args.vms } : {}),
      };
      return launchOne(i, opts, log);
    }),
  );
  results.sort((a, b) => a.shard - b.shard);

  console.log('');
  console.log(rule);
  console.log(' summary');
  console.log(rule);
  console.log(`  group_id: ${groupId}`);
  console.log('');
  let failed = 0;
  for (const r of results) {
    const tag = r.rc === 0 ? 'OK  ' : 'FAIL';
    console.log(`  shard ${pad(r.shard)}/${args.vms}  ${tag}  rc=${r.rc}  ${r.runId}`);
    if (r.rc !== 0) failed++;
  }
  console.log('');
  console.log(`  Watch:     npm run bench:burst-100k:watch -- ${results.map(r => r.runId).join(' ')}`);
  console.log(`  Aggregate: npm run bench:burst-100k:aggregate -- --group ${groupId}`);

  if (failed > 0) {
    console.log(`\n${failed}/${results.length} launches failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
