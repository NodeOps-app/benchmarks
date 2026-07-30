import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/cli';
import type { JsonObject } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from './stats.js';
import { computeStorageCompositeScores } from './scoring.js';
import { writeStorageResultsJson } from './benchmark.js';
import type { StorageProviderConfig, StorageBenchmarkResult, StorageTimingResult } from './types.js';

function num(x: unknown): number {
  return typeof x === 'number' ? x : 0;
}

/** Map CLI participant records to legacy storage BenchmarkResult[] (upload/download domain). */
export function recordsToStorageResults(
  participants: ParticipantRecords[],
  opts: { fileSizeBytes: number; providers: StorageProviderConfig[] },
): StorageBenchmarkResult[] {
  return participants.map((participant) => {
    const provider = participant.participant;
    const bucket = opts.providers.find((p) => p.name === participant.participant)?.bucket ?? '';

    const iterations: StorageTimingResult[] = byTaskIndex(participant.records).map((r) => {
      const d = (r.data ?? {}) as JsonObject;
      const base = {
        uploadMs: num(d.uploadMs),
        downloadMs: num(d.downloadMs),
        throughputMbps: num(d.throughputMbps),
        fileSizeBytes: num(d.fileSizeBytes) || opts.fileSizeBytes,
      };
      return r.status === 'error' ? { ...base, error: r.errorCode ?? 'error' } : base;
    });

    const successful = iterations.filter((i) => !i.error);
    const summary = {
      uploadMs: computeStats(successful.map((i) => i.uploadMs)),
      downloadMs: computeStats(successful.map((i) => i.downloadMs)),
      throughputMbps: computeStats(successful.map((i) => i.throughputMbps)),
    };

    return {
      provider,
      mode: 'storage' as const,
      bucket,
      fileSizeBytes: opts.fileSizeBytes,
      iterations,
      summary,
    };
  });
}

/**
 * Map records -> StorageBenchmarkResult[], compute composite scores, and write
 * both `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeStorageLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; fileSizeBytes: number; providers: StorageProviderConfig[] },
): Promise<void> {
  const results = recordsToStorageResults(participants, opts);
  computeStorageCompositeScores(results);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeStorageResultsJson(results, outPath);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
