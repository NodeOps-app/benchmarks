#!/usr/bin/env node
/**
 * Sharded launcher for the burst-100k benchmark.
 *
 * Spreads a single logical burst of N sandboxes across K Namespace VMs by
 * spawning K parallel `scripts/burst-100k-launch.sh` processes — each with
 * CONCURRENCY_TARGET = N/K, tagged with a shared GROUP_ID + per-VM
 * SHARD_INDEX. Each VM ends up as its own `runs` row in Postgres; combine
 * them after the fact with:
 *
 *   tsx scripts/burst-100k-aggregate.ts --group <GROUP_ID>
 *
 * Children launch in parallel so the bursts actually overlap in wall-clock
 * time (a sequential launch makes the shards finish minutes apart and
 * defeats the point of sharding).
 *
 * Usage:
 *   tsx scripts/burst-100k-launch-sharded.ts --provider e2b --total 100000 --vms 20
 *   tsx scripts/burst-100k-launch-sharded.ts -p e2b -t 100000 -v 20 --duration 2h
 *   npm run bench:burst-100k:sharded -- --provider e2b --total 100000 --vms 20
 */

import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Args {
  provider: string;
  total: number;
  vms: number;
  duration: string;
  machineType?: string;
  groupId?: string;
}

function usage(): string {
  return [
    'Usage: tsx scripts/burst-100k-launch-sharded.ts [options]',
    '',
    'Required:',
    '  --provider <name>, -p  Provider name (e2b, modal, runloop, ...)',
    '  --total <n>,    -t     Total concurrent sandboxes across all VMs',
    '  --vms <n>,      -v     Number of Namespace VMs to spread across',
    '                         (must divide --total evenly)',
    '',
    'Optional:',
    '  --duration <dur>       Namespace VM lifetime (default: 1h)',
    '  --machine-type <type>  Namespace machine type (default: launch.sh default)',
    '  --group-id <id>        Override the generated GROUP_ID',
    '  --help, -h             Print this help',
    '',
    'Examples:',
    '  npm run bench:burst-100k:sharded -- --provider e2b --total 100000 --vms 20',
    '  tsx scripts/burst-100k-launch-sharded.ts -p e2b -t 10000 -v 10 --duration 2h',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Partial<Args> = { duration: '1h' };
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

const args = parseArgs();
const perVm = args.total / args.vms;
const launchScript = path.resolve(__dirname, 'burst-100k-launch.sh');

// Build GROUP_ID and the per-shard RUN_IDs. Same timestamp + commit prefix
// for every shard so they sort together; suffix encodes shard position.
function shortSha(): string {
  try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return 'local'; }
}
function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
const sha = shortSha();
const sha8 = sha.slice(0, 8);
const stamp = utcStamp();
const groupId = args.groupId ?? `${stamp}-${sha8}-${args.provider}-g${args.vms}x${perVm}`;
const shardWidth = String(args.vms - 1).length;
const pad = (n: number): string => String(n).padStart(shardWidth, '0');
const runIds = Array.from({ length: args.vms }, (_, i) =>
  `${stamp}-${sha8}-${args.provider}-s${pad(i)}of${args.vms}`,
);

const rule = '═'.repeat(67);
console.log(rule);
console.log(' burst-100k :: sharded launch');
console.log(rule);
console.log(`  provider:   ${args.provider}`);
console.log(`  total:      ${args.total.toLocaleString()} sandboxes`);
console.log(`  vms:        ${args.vms}`);
console.log(`  per-vm:     ${perVm.toLocaleString()} sandboxes`);
console.log(`  duration:   ${args.duration}`);
if (args.machineType) console.log(`  machine:    ${args.machineType}`);
console.log(`  group_id:   ${groupId}`);
console.log('');

// Apply the Postgres schema ONCE up-front and tell each child to skip it.
// Parallel `CREATE TABLE/INDEX IF NOT EXISTS` runs race on pg_class; doing
// it here removes the contention entirely without depending on advisory
// locks (which break across Neon's `-pooler` PgBouncer endpoint).
if (!process.env.PG_URL) {
  console.error('PG_URL not set (check .env)');
  process.exit(2);
}
console.log('[sharded] applying Postgres schema (once, then SKIP_SCHEMA=1 for shards)…');
const schemaRes = spawnSync(
  'psql',
  [process.env.PG_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'db/burst-100k.sql'],
  { stdio: 'inherit' },
);
if (schemaRes.status !== 0) {
  console.error(`[sharded] schema apply failed (rc=${schemaRes.status}); aborting before any VMs are spawned`);
  process.exit(schemaRes.status ?? 1);
}
console.log('[sharded] schema applied.\n');

interface ShardResult { shard: number; runId: string; rc: number; }

function launchShard(shard: number): Promise<ShardResult> {
  const runId = runIds[shard];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROVIDER: args.provider,
    CONCURRENCY_TARGET: String(perVm),
    DURATION: args.duration,
    RUN_ID: runId,
    GROUP_ID: groupId,
    SHARD_INDEX: String(shard),
    SHARD_COUNT: String(args.vms),
    SKIP_SCHEMA: '1',
  };
  if (args.machineType) env.MACHINE_TYPE = args.machineType;

  const tag = `[s${pad(shard)}]`;
  const child = spawn('bash', [launchScript], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = (stream: NodeJS.ReadableStream): void => {
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => console.log(`${tag} ${line}`));
  };
  prefix(child.stdout!);
  prefix(child.stderr!);

  return new Promise<ShardResult>((resolve) => {
    child.on('close', (code) => resolve({ shard, runId, rc: code ?? 1 }));
    child.on('error', (err) => {
      console.log(`${tag} spawn error: ${err.message}`);
      resolve({ shard, runId, rc: 1 });
    });
  });
}

console.log(`spawning ${args.vms} parallel launches…\n`);
const results = await Promise.all(
  Array.from({ length: args.vms }, (_, i) => launchShard(i)),
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
  const tag = r.rc === 0 ? 'OK  ' : `FAIL`;
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
