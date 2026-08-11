/**
 * Ingest merged benchmark results into the benchmarks platform using the new
 * orchestrator endpoints.
 *
 * Usage: tsx src/ingest.ts --type <type>
 * Env:   BENCHMARKS_PLATFORM_URL (default: https://platform.computesdk.com)
 *        BENCHMARKS_PLATFORM_API_KEY (or COMPUTESDK_ADMIN_API_KEY, COMPUTESDK_API_KEY)
 *        GITHUB_SHA, GITHUB_REF, GITHUB_EVENT_NAME, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const DEFAULT_PLATFORM_URL = 'https://platform.computesdk.com';
const PLATFORM_URL = process.env.BENCHMARKS_PLATFORM_URL || DEFAULT_PLATFORM_URL;
const API_KEY =
  process.env.BENCHMARKS_PLATFORM_API_KEY ||
  process.env.COMPUTESDK_ADMIN_API_KEY ||
  process.env.COMPUTESDK_API_KEY;

const ORGANIZATION_ID = process.env.BENCHMARKS_PLATFORM_ORGANIZATION_ID;

if (!API_KEY) {
  console.error('BENCHMARKS_PLATFORM_API_KEY (or COMPUTESDK_ADMIN_API_KEY) is required');
  process.exit(1);
}

const baseUrl = `${PLATFORM_URL.replace(/\/+$/, '')}/api/v1`;

const args = process.argv.slice(2);
function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const typeArg = getArgValue('--type');
if (!typeArg) {
  console.error('Usage: tsx src/ingest.ts --type <type>');
  process.exit(1);
}

const triggeredBy =
  process.env.GITHUB_EVENT_NAME === 'schedule'
    ? 'scheduled'
    : process.env.GITHUB_EVENT_NAME === 'pull_request'
      ? 'pr'
      : 'manual';

const MAX_BATCH_SIZE = 1000;

interface ResultFile {
  filePath: string;
  group: string;
}

interface RawResultFile {
  version?: string;
  timestamp?: string;
  environment?: Record<string, unknown>;
  config?: Record<string, unknown>;
  results: any[];
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function api(method: string, route: string, body?: unknown): Promise<any> {
  const url = `${baseUrl}${route}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Platform API ${method} ${route} failed: ${response.status} ${text.slice(0, 500)}`);
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Result discovery
// ---------------------------------------------------------------------------

function latestExists(dir: string): string | undefined {
  const p = path.join(ROOT, 'results', dir, 'latest.json');
  return fs.existsSync(p) ? p : undefined;
}

function subDirs(dir: string): string[] {
  const p = path.join(ROOT, 'results', dir);
  if (!fs.existsSync(p)) return [];
  return fs
    .readdirSync(p, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function getResultFiles(type: string): ResultFile[] {
  const files: ResultFile[] = [];

  const add = (dir: string, group: string) => {
    const p = latestExists(dir);
    if (p) files.push({ filePath: p, group });
  };

  // Well-known benchmark layouts
  if (type === 'sandbox') {
    add('sequential_tti', 'sequential');
    add('staggered_tti', 'staggered');
    add('burst_tti', 'burst');
  } else if (type === 'storage') {
    for (const sub of subDirs('storage')) add(`storage/${sub}`, sub);
  } else if (type === 'snapshot-fork') {
    for (const sub of subDirs('snapshot-fork')) add(`snapshot-fork/${sub}`, sub);
  } else if (type === 'browser') {
    add('browser', 'default');
  } else if (type === 'browser-throughput') {
    add('browser-throughput', 'default');
  } else if (type === 'ai-gateway') {
    add('ai-gateway', 'default');
  } else if (type === 'sandbox-dax') {
    add('sandbox-dax', 'default');
  }

  // Generic fallback: non-special sandbox modes write to results/<type>_tti/latest.json
  // (matching merge-results.ts modeToDir), so probe both <type> and <type>_tti.
  if (files.length === 0) {
    const candidates = [type, `${type}_tti`];
    for (const dir of candidates) {
      add(dir, dir);
      for (const sub of subDirs(dir)) add(`${dir}/${sub}`, sub);
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function deriveBenchmarkSlug(type: string, group: string): string {
  if (type === 'sandbox') {
    if (group === 'sequential') return 'sandbox-tti-local';
    if (group === 'staggered') return 'sandbox-staggered-local';
    if (group === 'burst') return 'sandbox-burst-local';
  }
  if (type === 'storage') return 'storage-local';
  if (type === 'snapshot-fork') return 'snapshot-fork-local';
  if (type === 'browser') return 'browser-local';
  if (type === 'browser-throughput') return 'browser-throughput-local';
  if (type === 'ai-gateway') return 'ai-gateway';
  if (type === 'sandbox-dax') return 'sandbox-dax-local';
  return `${slugify(type)}-local`;
}

function deriveBenchmarkName(slug: string): string {
  return slug
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function deriveBenchmarkKind(type: string): string {
  if (['storage', 'snapshot-fork'].includes(type)) return 'storage';
  if (['browser', 'browser-throughput'].includes(type)) return 'browser';
  if (type === 'ai-gateway') return 'ai-gateway';
  return 'sandbox';
}

function makeRunKey(type: string, group: string): string {
  const parts = [
    'ingest',
    process.env.GITHUB_RUN_ID || 'local',
    process.env.GITHUB_RUN_ATTEMPT || '1',
    type,
    group === 'default' ? '' : group,
  ].filter(Boolean);
  const key = parts.join('-');
  return key.length > 200 ? key.slice(0, 200) : key;
}

// ---------------------------------------------------------------------------
// Iteration → task result mapping
// ---------------------------------------------------------------------------

interface TaskResultRecord {
  taskIndex: number;
  status: string;
  startedAt?: string;
  completedAt?: string;
  latencyMs?: number;
  firstCommandMs?: number | null;
  errorCode?: string | null;
  steps?: TaskStepRecord[];
  data?: Record<string, unknown>;
}

interface TaskStepRecord {
  name: string;
  status: 'success' | 'error';
  startedAt?: string;
  completedAt?: string;
  latencyMs?: number;
  errorCode?: string | null;
  data?: Record<string, unknown>;
}

function getStatus(iteration: any, result: any): string {
  if (result?.skipped || iteration?.skipped) return 'skipped';
  if (iteration?.error) return 'error';
  if (typeof iteration?.status === 'string' && iteration.status.trim()) {
    return iteration.status.trim();
  }
  return 'success';
}

function pickPrimaryLatencyKey(type: string, iteration: any): string | undefined {
  if (type === 'sandbox') return 'ttiMs';
  if (type === 'sandbox-dax') return 'totalMs';
  if (type === 'storage') return 'downloadMs';
  if (type === 'snapshot-fork') return 'forkFirstReadMs';
  if (type === 'browser' || type === 'browser-throughput') return 'totalMs';
  if (type === 'ai-gateway') {
    return iteration.mode === 'cold'
      ? (iteration.coldE2eMs !== undefined ? 'coldE2eMs' : 'ttftMs')
      : 'ttftMs';
  }

  // Generic fallback
  const candidates = ['totalMs', 'latencyMs', 'ttiMs', 'downloadMs'];
  for (const key of candidates) {
    if (typeof iteration?.[key] === 'number') return key;
  }
  for (const key of Object.keys(iteration || {})) {
    if (key.endsWith('Ms') && typeof iteration[key] === 'number') return key;
  }
  return undefined;
}

function buildTaskResult(
  taskIndex: number,
  iteration: any,
  result: any,
  type: string,
  timestamp: string,
): TaskResultRecord {
  const status = getStatus(iteration, result);
  const primaryKey = pickPrimaryLatencyKey(type, iteration);
  const latencyMs =
    status === 'success' && primaryKey && typeof iteration[primaryKey] === 'number'
      ? iteration[primaryKey]
      : undefined;

  const startedAt = timestamp;
  const completedAt = timestamp;
  const data: Record<string, unknown> = {};
  const steps: TaskStepRecord[] = [];

  if (status === 'success' && iteration && typeof iteration === 'object') {
    for (const [key, value] of Object.entries(iteration)) {
      if (key === 'error' || key === primaryKey) continue;

      if (typeof value === 'number' && Number.isFinite(value) && key.endsWith('Ms')) {
        steps.push({
          name: key.replace(/Ms$/, ''),
          status: 'success',
          startedAt,
          completedAt,
          latencyMs: value,
          errorCode: null,
          data: {},
        });
      } else if (value !== undefined && value !== null) {
        if (typeof value === 'number' && !Number.isFinite(value)) continue;
        data[key] = value;
      }
    }
  }

  const errorCode =
    status === 'error'
      ? String(iteration?.error || result?.error || 'UNKNOWN').slice(0, 100)
      : status === 'skipped'
        ? (result?.skipReason ? String(result.skipReason).slice(0, 100) : 'SKIPPED')
        : null;

  return {
    taskIndex,
    status,
    startedAt,
    completedAt,
    latencyMs,
    firstCommandMs: null,
    errorCode,
    steps: steps.length > 0 ? steps : undefined,
    data: Object.keys(data).length > 0 ? data : undefined,
  };
}

function buildResultRecords(result: any, type: string, timestamp: string): TaskResultRecord[] {
  if (result?.skipped) {
    return [
      {
        taskIndex: 0,
        status: 'skipped',
        startedAt: timestamp,
        completedAt: timestamp,
        latencyMs: undefined,
        firstCommandMs: null,
        errorCode: result.skipReason ? String(result.skipReason).slice(0, 100) : 'SKIPPED',
        data: {
          compositeScore: result.compositeScore,
          successRate: result.successRate,
          skipped: true,
          skipReason: result.skipReason,
        },
      },
    ];
  }

  const iterations = Array.isArray(result?.iterations) ? result.iterations : [];
  return iterations.map((iteration: any, index: number) =>
    buildTaskResult(index, iteration, result, type, timestamp),
  );
}

// ---------------------------------------------------------------------------
// Ingest flow
// ---------------------------------------------------------------------------

async function ingestProvider(
  benchmarkSlug: string,
  runId: string,
  providerName: string,
  result: any,
  type: string,
  timestamp: string,
  group: string,
) {
  const participantSlug = slugify(providerName);
  if (!participantSlug) {
    console.warn(`  Skipping provider with empty slug: ${providerName}`);
    return;
  }

  const records = buildResultRecords(result, type, timestamp);
  const totalTasks = records.length;

  const participantConfig: Record<string, unknown> = {
    compositeScore: result.compositeScore,
    successRate: result.successRate,
    skipped: result.skipped ?? false,
    skipReason: result.skipReason,
    group,
  };

  await api(
    'PUT',
    `/benchmarks/${encodeURIComponent(benchmarkSlug)}/runs/${encodeURIComponent(runId)}/participants/${encodeURIComponent(participantSlug)}`,
    {
      label: providerName,
      provider: providerName,
      totalTasks,
      workerCount: 1,
      config: participantConfig,
    },
  );

  const planned = await api(
    'POST',
    `/benchmarks/${encodeURIComponent(benchmarkSlug)}/runs/${encodeURIComponent(runId)}/participants/${encodeURIComponent(participantSlug)}/workers`,
    {
      workerCount: 1,
      targetConcurrency: totalTasks,
    },
  );

  const worker = planned.items?.[0] ?? planned.workers?.[0];
  if (!worker?.id) {
    throw new Error(`No worker planned for participant ${participantSlug}`);
  }

  const claimResponse = await api(
    'POST',
    `/benchmarks/${encodeURIComponent(benchmarkSlug)}/runs/${encodeURIComponent(runId)}/participants/${encodeURIComponent(participantSlug)}/workers/claim`,
    { processKind: 'ingest' },
  );
  const assignment = claimResponse?.assignment;

  if (!assignment?.workerId || !assignment?.attemptId) {
    throw new Error(`Could not claim worker for participant ${participantSlug}`);
  }

  for (let i = 0; i < records.length; i += MAX_BATCH_SIZE) {
    const batch = records.slice(i, i + MAX_BATCH_SIZE);
    const isFinal = i + batch.length >= records.length;
    await api(
      'POST',
      `/benchmarks/${encodeURIComponent(benchmarkSlug)}/runs/${encodeURIComponent(runId)}/workers/${encodeURIComponent(assignment.workerId)}/events`,
      {
        type: 'task_results',
        attemptId: assignment.attemptId,
        sequenceNumber: Math.floor(i / MAX_BATCH_SIZE),
        isFinal,
        records: batch,
      },
    );
  }

  await api(
    'POST',
    `/benchmarks/${encodeURIComponent(benchmarkSlug)}/runs/${encodeURIComponent(runId)}/workers/${encodeURIComponent(assignment.workerId)}/complete`,
    { attemptId: assignment.attemptId },
  );

  console.log(`  Ingested ${providerName}: ${records.length} task results`);
}

async function ingestFile(file: ResultFile, type: string) {
  const raw: RawResultFile = JSON.parse(fs.readFileSync(file.filePath, 'utf-8'));
  if (!Array.isArray(raw.results) || raw.results.length === 0) {
    console.log(`Skipping ${file.filePath}: no results`);
    return;
  }

  const groupMode = raw.config?.mode || file.group;
  const benchmarkSlug = deriveBenchmarkSlug(type, file.group);
  const benchmarkName = deriveBenchmarkName(benchmarkSlug);
  const benchmarkKind = deriveBenchmarkKind(type);

  await api('PUT', `/benchmarks/${encodeURIComponent(benchmarkSlug)}`, {
    name: benchmarkName,
    kind: benchmarkKind,
    status: 'active',
    ...(ORGANIZATION_ID ? { organizationId: ORGANIZATION_ID } : {}),
  });

  const runName = `${benchmarkName}${file.group === 'default' ? '' : ` (${file.group})`}`;
  const runKey = makeRunKey(type, file.group);
  const runConfig: Record<string, unknown> = {
    source: 'ingest',
    type,
    group: file.group,
    gitSha: process.env.GITHUB_SHA,
    gitRef: process.env.GITHUB_REF,
    triggeredBy,
    resultFile: path.relative(ROOT, file.filePath),
    resultTimestamp: raw.timestamp,
    environment: raw.environment,
  };
  if (groupMode && groupMode !== file.group) {
    runConfig.mode = groupMode;
  }

  const runResponse = await api('POST', `/benchmarks/${encodeURIComponent(benchmarkSlug)}/runs`, {
    name: runName,
    runKey,
    config: runConfig,
    ...(ORGANIZATION_ID ? { organizationId: ORGANIZATION_ID } : {}),
  });

  const runId = runResponse?.run?.id;
  if (!runId) {
    throw new Error(`Run creation did not return a run id for ${benchmarkSlug}`);
  }

  console.log(`Ingesting ${file.filePath} → ${benchmarkSlug} run ${runId} (key: ${runKey})`);

  const timestamp = raw.timestamp || new Date().toISOString();
  for (const result of raw.results) {
    await ingestProvider(benchmarkSlug, runId, result.provider, result, type, timestamp, file.group);
  }

  console.log(`Done ${file.filePath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const files = getResultFiles(typeArg!);
  if (files.length === 0) {
    console.log(`No result files found for type "${typeArg}"`);
    return;
  }

  for (const file of files) {
    await ingestFile(file, typeArg!);
  }
}

main().catch((err) => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
