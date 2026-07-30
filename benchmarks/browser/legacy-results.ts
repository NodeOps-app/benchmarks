import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from '../src/util/stats.js';
import { computeBrowserCompositeScores } from './scoring.js';
import { writeBrowserResultsJson } from './benchmark.js';
import type { BrowserBenchmarkResult, BrowserTimingResult } from './types.js';

function num(x: unknown): number {
  return typeof x === 'number' ? x : 0;
}

/** Map CLI participant records to legacy browser BenchmarkResult[]. */
export function recordsToBrowserResults(participants: ParticipantRecords[]): BrowserBenchmarkResult[] {
  return participants.map((participant) => {
    const iterations: BrowserTimingResult[] = byTaskIndex(participant.records).map((r) => {
      const d = (r.data ?? {}) as JsonObject;
      const base = {
        createMs: num(d.createMs),
        connectMs: num(d.connectMs),
        navigateMs: num(d.navigateMs),
        releaseMs: num(d.releaseMs),
        totalMs: num(d.totalMs),
      };
      return r.status === 'error'
        ? { ...base, error: (d.errorMessage as string) ?? r.errorCode ?? 'error' }
        : base;
    });

    const successful = iterations.filter((i) => !i.error);
    const summary = {
      createMs: computeStats(successful.map((i) => i.createMs)),
      connectMs: computeStats(successful.map((i) => i.connectMs)),
      navigateMs: computeStats(successful.map((i) => i.navigateMs)),
      releaseMs: computeStats(successful.map((i) => i.releaseMs)),
      totalMs: computeStats(successful.map((i) => i.totalMs)),
    };

    return {
      provider: participant.participant,
      mode: 'browser' as const,
      iterations,
      summary,
    };
  });
}

/**
 * Map records -> BrowserBenchmarkResult[], compute composite scores, and write
 * both `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeBrowserLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; timeoutMs: number },
): Promise<void> {
  const results = recordsToBrowserResults(participants);
  computeBrowserCompositeScores(results);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeBrowserResultsJson(results, outPath, { timeoutMs: opts.timeoutMs });

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
