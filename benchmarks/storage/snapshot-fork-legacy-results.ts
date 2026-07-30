import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from './stats.js';
import { computeSnapshotForkCompositeScores, writeSnapshotForkResultsJson } from './snapshot-fork-benchmark.js';
import type { StorageProviderConfig } from './types.js';
import type {
  DatasetPreset,
  DatasetSpec,
  SnapshotForkBenchmarkResult,
  SnapshotForkTimingResult,
} from './snapshot-fork-types.js';

function num(x: unknown): number {
  return typeof x === 'number' ? x : 0;
}

/** Map CLI participant records to legacy snapshot-fork BenchmarkResult[]. */
export function recordsToSnapshotForkResults(
  participants: ParticipantRecords[],
  opts: { dataset: DatasetPreset; spec: DatasetSpec; providers: StorageProviderConfig[] },
): SnapshotForkBenchmarkResult[] {
  const datasetBytes = opts.spec.objectCount * opts.spec.objectSizeBytes;

  return participants.map((participant) => {
    const bucket = opts.providers.find((p) => p.name === participant.participant)?.bucket ?? '';

    const iterations: SnapshotForkTimingResult[] = byTaskIndex(participant.records).map((r) => {
      const d = (r.data ?? {}) as JsonObject;
      const base = {
        seedMs: num(d.seedMs),
        snapshotCreateMs: num(d.snapshotCreateMs),
        forkFromSnapshotMs: num(d.forkFromSnapshotMs),
        forkFromLiveMs: num(d.forkFromLiveMs),
        forkFirstReadMs: num(d.forkFirstReadMs),
        verified: d.verified === true,
        datasetBytes: num(d.datasetBytes) || datasetBytes,
        objectCount: num(d.objectCount) || opts.spec.objectCount,
      };
      return r.status === 'error'
        ? { ...base, error: (d.errorMessage as string) ?? r.errorCode ?? 'error' }
        : base;
    });

    // Legacy computes summary stats over the `!error` subset (verified is only
    // used for success-rate in the composite score, not for the stats subset).
    const successful = iterations.filter((i) => !i.error);
    const summary = {
      snapshotCreateMs: computeStats(successful.map((i) => i.snapshotCreateMs)),
      forkFromSnapshotMs: computeStats(successful.map((i) => i.forkFromSnapshotMs)),
      forkFromLiveMs: computeStats(successful.map((i) => i.forkFromLiveMs)),
      forkFirstReadMs: computeStats(successful.map((i) => i.forkFirstReadMs)),
    };

    return {
      provider: participant.participant,
      mode: 'snapshot-fork' as const,
      bucket,
      dataset: opts.dataset,
      datasetBytes,
      objectCount: opts.spec.objectCount,
      iterations,
      summary,
    };
  });
}

/**
 * Map records -> SnapshotForkBenchmarkResult[], compute composite scores, and
 * write both `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeSnapshotForkLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; dataset: DatasetPreset; spec: DatasetSpec; providers: StorageProviderConfig[] },
): Promise<void> {
  const results = recordsToSnapshotForkResults(participants, opts);
  computeSnapshotForkCompositeScores(results);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeSnapshotForkResultsJson(results, outPath);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
