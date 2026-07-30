import crypto from 'crypto';
import type { Storage } from '@storagesdk/core';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { round, roundStats, computeStats } from './stats.js';
import type { StorageProviderConfig } from './types.js';
import {
  DATASET_PRESETS,
  type DatasetPreset,
  type DatasetSpec,
  type SnapshotForkBenchmarkResult,
  type SnapshotForkTimingResult,
} from './snapshot-fork-types.js';

/** Best-effort cleanup that never throws — logs and swallows. */
/**
 * Run one snapshot/fork iteration:
 *   seed dataset -> snapshot -> fork(from snapshot) -> fork(from live) ->
 *   read-back-from-fork (verify) -> teardown.
 *
 * Every created resource (objects, snapshot, both forks) is torn down in a
 * `finally` so a failure mid-iteration does not leak real storage or siblings.
 */
/**
 * Compute the success rate for a snapshot/fork result (0 to 1).
 * An iteration only counts as successful if it completed AND verified.
 */
export function computeSnapshotForkSuccessRate(result: SnapshotForkBenchmarkResult): number {
  if (result.skipped || result.iterations.length === 0) return 0;
  const ok = result.iterations.filter(i => !i.error && i.verified).length;
  return ok / result.iterations.length;
}

/** Absolute ceiling for snapshot/fork latency in ms. At or above this scores 0. */
const LATENCY_CEILING_MS = 60000;

function scoreLatency(valueMs: number): number {
  return Math.max(0, 100 * (1 - valueMs / LATENCY_CEILING_MS));
}

/**
 * Compute composite scores in place. Snapshot create and fork create dominate;
 * fork read is a small tiebreaker. compositeScore = latencyScore × successRate.
 */
export function computeSnapshotForkCompositeScores(results: SnapshotForkBenchmarkResult[]): void {
  for (const result of results) {
    const successRate = computeSnapshotForkSuccessRate(result);
    result.successRate = successRate;

    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    const score =
      0.40 * scoreLatency(result.summary.snapshotCreateMs.median) +
      0.35 * scoreLatency(result.summary.forkFromSnapshotMs.median) +
      0.15 * scoreLatency(result.summary.forkFromLiveMs.median) +
      0.10 * scoreLatency(result.summary.forkFirstReadMs.median);

    result.compositeScore = Math.round(score * successRate * 100) / 100;
  }
}

export async function writeSnapshotForkResultsJson(
  results: SnapshotForkBenchmarkResult[],
  outPath: string,
): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    bucket: r.bucket,
    dataset: r.dataset,
    datasetBytes: r.datasetBytes,
    objectCount: r.objectCount,
    iterations: r.iterations.map(i => ({
      seedMs: round(i.seedMs),
      snapshotCreateMs: round(i.snapshotCreateMs),
      forkFromSnapshotMs: round(i.forkFromSnapshotMs),
      forkFromLiveMs: round(i.forkFromLiveMs),
      forkFirstReadMs: round(i.forkFirstReadMs),
      verified: i.verified,
      datasetBytes: i.datasetBytes,
      objectCount: i.objectCount,
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      snapshotCreateMs: roundStats(r.summary.snapshotCreateMs),
      forkFromSnapshotMs: roundStats(r.summary.forkFromSnapshotMs),
      forkFromLiveMs: roundStats(r.summary.forkFromLiveMs),
      forkFirstReadMs: roundStats(r.summary.forkFirstReadMs),
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      iterations: results[0]?.iterations.length || 0,
      timeoutMs: 60000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
