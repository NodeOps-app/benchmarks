import fs from 'fs';
import os from 'os';
import type { ProviderConfig, Stats } from './types.js';
import { computeStats } from '../util/stats.js';
import { withTimeout } from '../util/timeout.js';

const BENCH_SCRIPT_URL = 'https://raw.githubusercontent.com/anomalyco/opencode/provider-benchmark/script/provider-benchmark.sh';

export interface DaxTimingResult {
  totalMs: number;
  phasesCompleted?: number;
  phasesTotal?: number;
  prepareMs?: number;
  bunDownloadMs?: number;
  bunUnpackMs?: number;
  cloneMs?: number;
  installMs?: number;
  typecheckMs?: number;
  cacheClearMs?: number;
  diskAfterClone?: number;
  diskAfterInstall?: number;
  diskAfterTypecheck?: number;
  commit?: string;
  bunVersion?: string;
  nodeVersion?: string;
  architecture?: string;
  kernel?: string;
  logicalCpus?: string;
  cpuModel?: string;
  memoryKib?: string;
  error?: string;
}

export interface DaxBenchmarkResult {
  provider: string;
  mode: 'sandbox-dax';
  iterations: DaxTimingResult[];
  summary: {
    totalMs: Stats;
    prepareMs: Stats;
    bunDownloadMs: Stats;
    bunUnpackMs: Stats;
    cloneMs: Stats;
    installMs: Stats;
    typecheckMs: Stats;
  };
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}

export async function runDaxBenchmark(config: ProviderConfig): Promise<DaxBenchmarkResult> {
  const { name, iterations = 3, timeout = 600_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs = 15_000 } = config;

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'sandbox-dax',
      iterations: [],
      summary: emptySummary(),
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = config.createCompute();
  const results: DaxTimingResult[] = [];

  console.log(`\n--- Dax Benchmark: ${name} (${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);
    let sandbox: any = null;

    try {
      sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');
      const result = await runDaxIteration(sandbox, name, timeout);
      results.push(result);
      if (result.error) {
        const parts = [];
        if (result.prepareMs) parts.push(`prepare ${(result.prepareMs / 1000).toFixed(2)}s`);
        if (result.bunDownloadMs) parts.push(`bun dl ${(result.bunDownloadMs / 1000).toFixed(2)}s`);
        if (result.bunUnpackMs) parts.push(`bun unpack ${(result.bunUnpackMs / 1000).toFixed(2)}s`);
        if (result.cloneMs) parts.push(`clone ${(result.cloneMs / 1000).toFixed(2)}s`);
        if (result.installMs) parts.push(`install ${(result.installMs / 1000).toFixed(2)}s`);
        if (result.typecheckMs) parts.push(`typecheck ${(result.typecheckMs / 1000).toFixed(2)}s`);
        const phaseStr = parts.length > 0 ? ` | ${parts.join(' | ')}` : '';
        const score = result.phasesCompleted != null ? `${result.phasesCompleted}/${result.phasesTotal}` : '';
        console.log(`    FAILED${score ? ` (${score} phases)` : ''}: ${result.error}${phaseStr}`);
      } else {
        const fmt = (ms?: number) => ms ? `${(ms / 1000).toFixed(2)}s` : 'N/A';
        console.log(`    OK (${result.phasesCompleted}/${result.phasesTotal}): total ${fmt(result.totalMs)} | prepare ${fmt(result.prepareMs)} | clone ${fmt(result.cloneMs)} | install ${fmt(result.installMs)} | typecheck ${fmt(result.typecheckMs)}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`    FAILED: ${error}`);
      results.push({ totalMs: 0, error });
    } finally {
      if (sandbox) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            sandbox.destroy(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Destroy timeout')), destroyTimeoutMs);
            }),
          ]);
        } catch (err) {
          console.warn(`    [cleanup] destroy failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    }
  }

  const successful = results.filter(r => !r.error);
  const withTiming = results.filter(r => r.totalMs > 0 && (r.phasesCompleted ?? 0) > 0);

  return {
    provider: name,
    mode: 'sandbox-dax',
    iterations: results,
    summary: withTiming.length > 0 ? summarize(withTiming) : emptySummary(),
    successRate: results.length > 0 ? successful.length / results.length : 0,
  };
}

async function runDaxIteration(sandbox: any, providerName: string, timeout: number): Promise<DaxTimingResult> {
  const script = String.raw`
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');

const scriptUrl = ${JSON.stringify(BENCH_SCRIPT_URL)};
const provider = ${JSON.stringify(providerName)};

const start = performance.now();

// Download and run the dax benchmark script via curl|bash.
// The script emits structured BENCH_PHASE / BENCH_META / BENCH_DISK / BENCH_DONE
// lines on stdout and BENCH_ERROR on stderr that we parse below.
// If curl is not available the script will fail (which is expected and tracked).
const result = spawnSync('bash', ['-c', 'curl -fsSL ' + scriptUrl + ' | BENCH_PROVIDER=' + provider + ' BENCH_REGION=unknown bash'], {
  encoding: 'utf8',
  timeout: 540000,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BENCH_PROVIDER: provider, BENCH_REGION: 'unknown' },
});

const totalMs = performance.now() - start;
const stdout = result.stdout || '';
const stderr = result.stderr || '';
const exitCode = result.status;

// Parse structured output lines
const phases = {};
const meta = {};
const disk = {};
let benchError = null;
let doneCommit = null;

for (const line of stdout.split('\n')) {
  if (line.startsWith('BENCH_PHASE\t')) {
    const parts = line.split('\t');
    if (parts.length >= 3) phases[parts[1]] = parseInt(parts[2], 10);
  } else if (line.startsWith('BENCH_META\t')) {
    const parts = line.split('\t');
    if (parts.length >= 3) meta[parts[1]] = parts[2];
  } else if (line.startsWith('BENCH_DISK\t')) {
    const parts = line.split('\t');
    if (parts.length >= 3) disk[parts[1]] = parseInt(parts[2], 10);
  } else if (line.startsWith('BENCH_DONE\t')) {
    const parts = line.split('\t');
    if (parts.length >= 2) doneCommit = parts[1];
  }
}

for (const line of stderr.split('\n')) {
  if (line.startsWith('BENCH_ERROR\t')) {
    const parts = line.split('\t');
    benchError = parts.slice(1).join(': ');
  }
}

if (exitCode !== 0 && !benchError) {
  // Include last few lines of stderr for diagnostics
  const tail = stderr.trim().split('\n').slice(-3).join(' | ');
  benchError = 'Script exited with code ' + exitCode + (tail ? ': ' + tail : '');
}
if (result.error) {
  benchError = result.error.message || String(result.error);
}

// Count completed phases
const phaseKeys = ['prepare', 'cache_clear', 'bun_download', 'bun_unpack', 'clone', 'install', 'typecheck'];
const rawPhasesCompleted = phaseKeys.filter(k => phases[k] !== undefined).length;
// The script's phase() function emits BENCH_PHASE even for the failing phase (it prints timing before checking exit code).
// When there's an error, the last phase that emitted a BENCH_PHASE line is the one that failed, so don't count it.
const phasesCompleted = benchError ? Math.max(0, rawPhasesCompleted - 1) : rawPhasesCompleted;

// If no phases completed, the script didn't actually run (e.g. curl missing)
if (phasesCompleted === 0 && !benchError) {
  const tail = stderr.trim().split('\n').slice(-2).join(' | ');
  benchError = 'No benchmark phases completed' + (tail ? ': ' + tail : ' (curl may not be available)');
}

console.log(JSON.stringify({
  totalMs,
  phasesCompleted,
  phasesTotal: phaseKeys.length,
  prepareMs: phases.prepare,
  cacheClearMs: phases.cache_clear,
  bunDownloadMs: phases.bun_download,
  bunUnpackMs: phases.bun_unpack,
  cloneMs: phases.clone,
  installMs: phases.install,
  typecheckMs: phases.typecheck,
  diskAfterClone: disk.after_clone,
  diskAfterInstall: disk.after_install,
  diskAfterTypecheck: disk.after_typecheck,
  commit: doneCommit || meta.commit,
  bunVersion: meta.bun_version,
  nodeVersion: meta.node_version,
  architecture: meta.architecture,
  kernel: meta.kernel,
  logicalCpus: meta.logical_cpus,
  cpuModel: meta.cpu_model,
  memoryKib: meta.memory_kib,
  ...(benchError ? { error: benchError } : {}),
}));
`;

  const result = await withTimeout(
    sandbox.runCommand(`node <<'NODE'\n${script}\nNODE`),
    timeout,
    'Dax benchmark timed out',
  ) as { exitCode: number; stdout?: string; stderr?: string };

  if (result.exitCode !== 0) {
    throw new Error(`Dax benchmark failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
  }

  const jsonLine = (result.stdout || '').trim().split('\n').reverse().find(line => line.trim().startsWith('{'));
  if (!jsonLine) throw new Error('Dax benchmark did not emit JSON results');
  return JSON.parse(jsonLine) as DaxTimingResult;
}

function summarize(results: DaxTimingResult[]): DaxBenchmarkResult['summary'] {
  const empty = { median: 0, p95: 0, p99: 0 };
  const pick = (key: keyof DaxTimingResult) => {
    const values = results.map(r => r[key]).filter((v): v is number => typeof v === 'number' && v > 0);
    return values.length > 0 ? computeStats(values) : empty;
  };
  return {
    totalMs: pick('totalMs'),
    prepareMs: pick('prepareMs'),
    bunDownloadMs: pick('bunDownloadMs'),
    bunUnpackMs: pick('bunUnpackMs'),
    cloneMs: pick('cloneMs'),
    installMs: pick('installMs'),
    typecheckMs: pick('typecheckMs'),
  };
}

function emptySummary(): DaxBenchmarkResult['summary'] {
  const empty = { median: 0, p95: 0, p99: 0 };
  return { totalMs: empty, prepareMs: empty, bunDownloadMs: empty, bunUnpackMs: empty, cloneMs: empty, installMs: empty, typecheckMs: empty };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function writeDaxResultsJson(results: DaxBenchmarkResult[], outPath: string): Promise<void> {
  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map(i => ({
      totalMs: round(i.totalMs),
      ...(i.phasesCompleted !== undefined ? { phasesCompleted: i.phasesCompleted } : {}),
      ...(i.phasesTotal !== undefined ? { phasesTotal: i.phasesTotal } : {}),
      ...(i.prepareMs !== undefined ? { prepareMs: round(i.prepareMs) } : {}),
      ...(i.cacheClearMs !== undefined ? { cacheClearMs: round(i.cacheClearMs) } : {}),
      ...(i.bunDownloadMs !== undefined ? { bunDownloadMs: round(i.bunDownloadMs) } : {}),
      ...(i.bunUnpackMs !== undefined ? { bunUnpackMs: round(i.bunUnpackMs) } : {}),
      ...(i.cloneMs !== undefined ? { cloneMs: round(i.cloneMs) } : {}),
      ...(i.installMs !== undefined ? { installMs: round(i.installMs) } : {}),
      ...(i.typecheckMs !== undefined ? { typecheckMs: round(i.typecheckMs) } : {}),
      ...(i.diskAfterClone !== undefined ? { diskAfterClone: i.diskAfterClone } : {}),
      ...(i.diskAfterInstall !== undefined ? { diskAfterInstall: i.diskAfterInstall } : {}),
      ...(i.diskAfterTypecheck !== undefined ? { diskAfterTypecheck: i.diskAfterTypecheck } : {}),
      ...(i.commit ? { commit: i.commit } : {}),
      ...(i.bunVersion ? { bunVersion: i.bunVersion } : {}),
      ...(i.nodeVersion ? { nodeVersion: i.nodeVersion } : {}),
      ...(i.architecture ? { architecture: i.architecture } : {}),
      ...(i.kernel ? { kernel: i.kernel } : {}),
      ...(i.logicalCpus ? { logicalCpus: i.logicalCpus } : {}),
      ...(i.cpuModel ? { cpuModel: i.cpuModel } : {}),
      ...(i.memoryKib ? { memoryKib: i.memoryKib } : {}),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: Object.fromEntries(Object.entries(r.summary).map(([key, stats]) => [key, {
      median: round(stats.median),
      p95: round(stats.p95),
      p99: round(stats.p99),
    }])),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: os.platform(), arch: os.arch() },
    config: { mode: 'sandbox-dax', timeoutMs: 600000, scriptUrl: BENCH_SCRIPT_URL },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
