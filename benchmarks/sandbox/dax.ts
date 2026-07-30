/**
 * Dax result types, summarization, and the legacy `results/sandbox-dax/` JSON
 * writer. The workload (build execution + phase parsing) lives in
 * dax.bench.ts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Stats } from './types.js';
import { computeStats } from '../src/util/stats.js';

/** The build script the dax task uploads into each sandbox. */
export const BENCH_SCRIPT_PATH = path.resolve(import.meta.dirname, '../scripts/dax-benchmark.sh');

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

export function summarize(results: DaxTimingResult[]): DaxBenchmarkResult['summary'] {
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

export function emptySummary(): DaxBenchmarkResult['summary'] {
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
    config: { mode: 'sandbox-dax', timeoutMs: 600000, scriptSource: 'local', scriptPath: BENCH_SCRIPT_PATH },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
