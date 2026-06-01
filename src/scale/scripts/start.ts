#!/usr/bin/env node
/**
 * Launcher for the scale benchmark.
 *
 * Spreads a single logical burst of N sandboxes across K Namespace VM-backed
 * containers by launching K `nsc run --image ...` jobs in parallel — each with
 * CONCURRENCY_TARGET = N/K, tagged with a shared GROUP_ID + per-VM
 * SHARD_INDEX. A single-VM run is just `--vms 1` (the default).
 *
 * Each VM gets its own RUN_ID; combine shards after the fact with:
 *
 *   tsx src/scale/scripts/aggregate.ts --group <GROUP_ID>
 *
 * Usage:
 *   tsx src/scale/scripts/start.ts --provider e2b --total 100000 --vms 20
 *   tsx src/scale/scripts/start.ts -p e2b -t 100000 -v 20 --duration 2h
 *   tsx src/scale/scripts/start.ts -p e2b -t 1000 -v 1   # single VM
 *   npm run bench:scale:start -- --provider e2b --total 100000 --vms 20
 *
 * Required env:
 *   TIGRIS_STORAGE_ENDPOINT, _BUCKET  Tigris (S3-compat) target for raw results
 *   TIGRIS_STORAGE_ACCESS_KEY_ID
 *   TIGRIS_STORAGE_SECRET_ACCESS_KEY
 *   Provider-specific keys            e.g. E2B_API_KEY (validated by coordinator)
 *
 * Optional env:
 *   GITHUB_SHA                Defaults to `git rev-parse HEAD` or "local"
 *   COMPUTESDK_API_KEY        Bench ingest token (Bearer)
 *   SCALE_IMAGE_REPO          Default image repository when --image is unset
 *                             (default: nscr.io/5enq753trme1k/scale)
 *   SCALE_IMAGE_TAG           Default image tag when --image is unset
 *                             (default: latest)
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is <repo>/src/scale/scripts.
const repoRoot = path.resolve(__dirname, '../../..');

// Provider-specific credentials forwarded to the VM. The coordinator's
// `requiredEnvVars` check fails fast if its provider's vars are missing, so we
// just forward whatever is present in this process's env.
const PROVIDER_SECRET_VARS = [
  'E2B_API_KEY', 'MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET', 'DAYTONA_API_KEY',
  'CSB_API_KEY', 'RUNLOOP_API_KEY', 'TENSORLAKE_API_KEY', 'DECLAW_API_KEY',
  'VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'NORTHFLANK_TOKEN', 'NORTHFLANK_PROJECT_ID'
];

const MACHINE_TYPE_DEFAULT = '1x2';
const DEFAULT_SCALE_IMAGE_REPO = process.env.SCALE_IMAGE_REPO ?? 'nscr.io/5enq753trme1k/scale';
const DEFAULT_SCALE_IMAGE_TAG = process.env.SCALE_IMAGE_TAG ?? 'latest';
const DEFAULT_SCALE_IMAGE = `${DEFAULT_SCALE_IMAGE_REPO}:${DEFAULT_SCALE_IMAGE_TAG}`;

// ----- helpers --------------------------------------------------------------

type Logger = (line: string) => void;

interface RunResult { code: number; stdout: string; }

/**
 * Async wrapper around `spawn` for `nsc`. Streams stdout+stderr to
 * `log` line-by-line (so parallel shards stay readable) and optionally captures
 * stdout. Never rejects — resolves with the exit code so callers decide.
 */
function sh(
  cmd: string,
  args: string[],
  opts: { log: Logger; capture?: boolean; quiet?: boolean } = { log: () => { } },
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
  image?: string;
  total: number;
  vms: number;
  duration: string;
  machineType: string;
  groupId?: string;
  label?: string;
  retries: number;
}

function usage(): string {
  return [
    'Usage: tsx src/scale/scripts/start.ts [options]',
    '',
    'Required:',
    '  --provider <name>, -p  Provider name (e2b, modal, runloop, ...)',
    '  --image <ref>,  -i     Container image to run with `nsc run`',
    '  --total <n>,    -t     Total concurrent sandboxes across all VMs',
    '',
    'Optional:',
    '  --vms <n>,      -v     Number of Namespace VMs to spread across',
    '                         (must divide --total evenly; default: 1)',
    `  --duration <dur>       Namespace VM lifetime (default: 1h)`,
    `  --machine-type <type>  Namespace machine type (default: ${MACHINE_TYPE_DEFAULT})`,
    '  --group-id <id>        Override the generated GROUP_ID',
    '  --label <name>         Override the bench run label (default: scale.<provider>)',
    '  --retries <n>          Re-launch failed shards up to n extra times (default: 0)',
    '  --help, -h             Print this help',
    '',
    'Examples:',
    `                         (default: ${DEFAULT_SCALE_IMAGE})`,
    '  npm run bench:scale:start -- --provider e2b --total 100000 --vms 20',
    '  tsx src/scale/scripts/start.ts -p e2b -t 1000 -v 1 --duration 30m',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Partial<Args> = { vms: 1, duration: '1h', machineType: MACHINE_TYPE_DEFAULT, retries: 0 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2); }
      return v;
    };
    if (a === '--provider' || a === '-p') out.provider = next();
    else if (a === '--image' || a === '-i') out.image = next();
    else if (a === '--total' || a === '-t') out.total = parseInt(next(), 10);
    else if (a === '--vms' || a === '-v') out.vms = parseInt(next(), 10);
    else if (a === '--duration') out.duration = next();
    else if (a === '--machine-type') out.machineType = next();
    else if (a === '--group-id') out.groupId = next();
    else if (a === '--label') out.label = next();
    else if (a === '--retries') out.retries = parseInt(next(), 10);
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
  if (!Number.isFinite(out.retries) || (out.retries as number) < 0) {
    console.error(`--retries must be a non-negative integer\n${usage()}`); process.exit(2);
  }
  return out as Args;
}

// ----- per-VM launch --------------------------------------------------------

interface ShardOpts {
  provider: string;
  image: string;
  runId: string;
  concurrencyTarget: number;
  duration: string;
  machineType: string;
  githubSha: string;
  label?: string;
  // Sharded metadata; undefined for single-VM runs.
  groupId?: string;
  shardIndex?: number;
  shardCount?: number;
}

interface ShardResult { shard: number; runId: string; rc: number; }

/**
 * Start one shard as a native Namespace container (`nsc run --image ...`).
 * Never throws — resolves
 * with rc so a failed shard doesn't take down its siblings.
 */
async function launchOne(shard: number, opts: ShardOpts, log: Logger): Promise<ShardResult> {
  try {
    // 1. run image as a Namespace containerized job
    log(`starting container (image=${opts.image} machine=${opts.machineType} duration=${opts.duration})`);
    const runArgs = [
      'run',
      '--image', opts.image,
      '--machine_type', opts.machineType,
      '--duration', opts.duration,
      '--name', opts.runId,
      '--wait',
      '-o', 'json',
      '--env', `RUN_ID=${opts.runId}`,
      '--env', `PROVIDER=${opts.provider}`,
      '--env', `GITHUB_SHA=${opts.githubSha}`,
      '--env', `TIGRIS_STORAGE_ENDPOINT=${process.env.TIGRIS_STORAGE_ENDPOINT!}`,
      '--env', `TIGRIS_STORAGE_BUCKET=${process.env.TIGRIS_STORAGE_BUCKET!}`,
      '--env', `TIGRIS_STORAGE_ACCESS_KEY_ID=${process.env.TIGRIS_STORAGE_ACCESS_KEY_ID!}`,
      '--env', `TIGRIS_STORAGE_SECRET_ACCESS_KEY=${process.env.TIGRIS_STORAGE_SECRET_ACCESS_KEY!}`,
      '--env', `CONCURRENCY_TARGET=${opts.concurrencyTarget}`,
      // Have the bench SDK tee the coordinator's output to a file in-container,
      // in addition to the logger's in-memory buffer uploaded as coordinator.log.
      '--env', `COORDINATOR_LOG_PATH=/tmp/coordinator.log`,
    ];
    if (process.env.COMPUTESDK_API_KEY) {
      runArgs.push('--env', `COMPUTESDK_API_KEY=${process.env.COMPUTESDK_API_KEY}`);
    }
    if (opts.label !== undefined) {
      runArgs.push('--env', `LABEL=${opts.label}`);
    }
    if (opts.groupId !== undefined && opts.shardIndex !== undefined && opts.shardCount !== undefined) {
      runArgs.push('--env', `GROUP_ID=${opts.groupId}`);
      runArgs.push('--env', `SHARD_INDEX=${opts.shardIndex}`);
      runArgs.push('--env', `SHARD_COUNT=${opts.shardCount}`);
    }
    for (const v of PROVIDER_SECRET_VARS) {
      const val = process.env[v];
      if (val) runArgs.push('--env', `${v}=${val}`);
    }
    const run = await sh('nsc', runArgs, { log, capture: true });
    if (run.code !== 0) {
      log(`ERROR: nsc run failed (rc=${run.code})`);
      return { shard, runId: opts.runId, rc: 1 };
    }

    let instanceId = '';
    try {
      const payload = JSON.parse(run.stdout);
      instanceId = String(payload.instance_id ?? payload.cluster_id ?? '').trim();
    } catch {
      // fallthrough
    }
    if (!instanceId) {
      log('ERROR: could not parse instance_id from nsc run output');
      return { shard, runId: opts.runId, rc: 1 };
    }
    log(`instance: ${instanceId}`);

    // 2. confirm the coordinator launched. Past failures silently left the VM
    // idle, so this is load-bearing. A simple "instance is alive" check is
    // enough now that benchmark state is fully event-driven.
    let confirmed = false;
    for (let i = 1; i <= 12; i++) {
      const alive = await sh('nsc', ['describe', instanceId], { log, quiet: true });
      if (alive.code === 0) { log(`coordinator confirmed running on VM (after ${i})`); confirmed = true; break; }
      await sleep(1000);
    }
    if (!confirmed) {
      log('ERROR: coordinator not running and run not terminal after timeout');
      return { shard, runId: opts.runId, rc: 1 };
    }

    log(`OK  run_id=${opts.runId}  instance=${instanceId}`);
    log(`  Tail logs:  nsc logs ${instanceId} --follow`);
    log(`  Destroy:    nsc destroy --force ${instanceId}`);
    return { shard, runId: opts.runId, rc: 0 };
  } catch (err) {
    log(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return { shard, runId: opts.runId, rc: 1 };
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
  console.log(' scale :: launch');
  console.log(rule);
  console.log(`  provider:   ${args.provider}`);
  const image = args.image ?? DEFAULT_SCALE_IMAGE;
  console.log(`  image:      ${image}`);
  console.log(`  total:      ${args.total.toLocaleString()} sandboxes`);
  console.log(`  vms:        ${args.vms}`);
  console.log(`  per-vm:     ${perVm.toLocaleString()} sandboxes`);
  console.log(`  duration:   ${args.duration}`);
  console.log(`  machine:    ${args.machineType}`);
  console.log(`  group_id:   ${groupId}`);
  console.log(`  label:      ${args.label ?? `scale.${args.provider}`}`);
  console.log('');

  for (const v of ['TIGRIS_STORAGE_ENDPOINT', 'TIGRIS_STORAGE_BUCKET', 'TIGRIS_STORAGE_ACCESS_KEY_ID', 'TIGRIS_STORAGE_SECRET_ACCESS_KEY']) {
    if (!process.env[v]) { console.error(`${v} not set (check .env)`); process.exit(2); }
  }

  const sharded = args.vms > 1;

  // Launch a single shard. attempt 0 uses the canonical RUN_ID; retries mint a
  // fresh `-r{attempt}` RUN_ID so `nsc run --name` can't collide with the
  // failed instance. GROUP_ID + SHARD_INDEX stay fixed, so batch watch and
  // aggregate still see it as the same shard (local RUN_IDs aren't sent to the
  // bench API — see the Watch note below).
  const launchShard = (i: number, attempt: number): Promise<ShardResult> => {
    const tag = sharded ? `[s${pad(i)}${attempt > 0 ? `r${attempt}` : ''}] ` : '';
    const log: Logger = (line) => console.log(`${tag}${line}`);
    const opts: ShardOpts = {
      provider: args.provider,
      image,
      runId: attempt > 0 ? `${runIds[i]}-r${attempt}` : runIds[i],
      concurrencyTarget: perVm,
      duration: args.duration,
      machineType: args.machineType,
      githubSha,
      label: args.label,
      ...(sharded ? { groupId, shardIndex: i, shardCount: args.vms } : {}),
    };
    return launchOne(i, opts, log);
  };

  console.log(`spawning ${args.vms} parallel launch(es)…\n`);
  const results = await Promise.all(
    Array.from({ length: args.vms }, (_, i) => launchShard(i, 0)),
  );

  // Re-launch any shards whose launch failed, up to --retries extra rounds.
  // Keyed by shard index so the latest attempt's result replaces the earlier one.
  const byShard = new Map(results.map((r) => [r.shard, r]));
  for (let attempt = 1; attempt <= args.retries; attempt++) {
    const failedShards = [...byShard.values()].filter((r) => r.rc !== 0).map((r) => r.shard).sort((a, b) => a - b);
    if (failedShards.length === 0) break;
    console.log(`\nretry ${attempt}/${args.retries}: re-launching ${failedShards.length} failed shard(s): ${failedShards.map(pad).join(', ')}\n`);
    const retried = await Promise.all(failedShards.map((i) => launchShard(i, attempt)));
    for (const r of retried) byShard.set(r.shard, r);
  }

  const finalResults = [...byShard.values()].sort((a, b) => a.shard - b.shard);

  console.log('');
  console.log(rule);
  console.log(' summary');
  console.log(rule);
  console.log(`  group_id: ${groupId}`);
  console.log('');
  let failed = 0;
  for (const r of finalResults) {
    const tag = r.rc === 0 ? 'OK  ' : 'FAIL';
    console.log(`  shard ${pad(r.shard)}/${args.vms}  ${tag}  rc=${r.rc}  ${r.runId}`);
    if (r.rc !== 0) failed++;
  }
  console.log('');
  // The bench API mints its own run_… ids and only exposes shards under the
  // batch (= group_id); the local RUN_IDs above are never sent to it. So watch
  // by batch when sharded, and fall back to --recent for a lone run.
  const watchTarget = sharded ? `--batch ${groupId} --expected ${args.total}` : `--recent 1`;
  console.log(`  Watch:     npm run bench:scale:watch -- ${watchTarget}`);
  console.log(`  Aggregate: npm run bench:scale:aggregate -- --group ${groupId}`);

  if (failed > 0) {
    console.log(`\n${failed}/${finalResults.length} launches failed${args.retries > 0 ? ` after ${args.retries} retr${args.retries === 1 ? 'y' : 'ies'}` : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
