import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { summarizeIterations, writeThroughputResultsJson } from './throughput-benchmark.js';
import { computeThroughputCompositeScores } from './throughput-scoring.js';
import type {
  ActionResult,
  ActionType,
  ThroughputBenchmarkResult,
  ThroughputTimingResult,
} from './throughput-types.js';

function num(x: unknown): number {
  return typeof x === 'number' ? x : 0;
}

/**
 * Map CLI participant records to legacy browser-throughput BenchmarkResult[].
 * Reconstructs each `ThroughputTimingResult` (including the per-action `actions`
 * array) from the record's `data` payload, then re-derives the summary via the
 * legacy `summarizeIterations` so `perActionType` stats match exactly.
 */
export function recordsToThroughputResults(participants: ParticipantRecords[]): ThroughputBenchmarkResult[] {
  return participants.map((participant) => {
    const iterations: ThroughputTimingResult[] = byTaskIndex(participant.records).map((r) => {
      const d = (r.data ?? {}) as JsonObject;
      const rawActions = Array.isArray(d.actions) ? (d.actions as unknown as any[]) : [];
      const actions: ActionResult[] = rawActions.map((a) => ({
        index: num(a.index),
        type: a.type as ActionType,
        durationMs: num(a.durationMs),
        success: a.success === true,
        ...(a.error ? { error: String(a.error) } : {}),
      }));

      const iter: ThroughputTimingResult = {
        createMs: num(d.createMs),
        connectMs: num(d.connectMs),
        releaseMs: num(d.releaseMs),
        totalMs: num(d.totalMs),
        taskMs: num(d.taskMs),
        actionsCompleted: num(d.actionsCompleted),
        actionsPerSecond: num(d.actionsPerSecond),
        actions,
      };
      if (r.status === 'error') {
        iter.error = (d.errorMessage as string) ?? r.errorCode ?? 'error';
      }
      return iter;
    });

    return {
      provider: participant.participant,
      mode: 'browser-throughput' as const,
      iterations,
      summary: summarizeIterations(iterations),
    };
  });
}

/**
 * Map records -> ThroughputBenchmarkResult[], compute composite scores, and
 * write both `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeThroughputLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; timeoutMs: number },
): Promise<void> {
  const results = recordsToThroughputResults(participants);
  computeThroughputCompositeScores(results);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeThroughputResultsJson(results, outPath, { timeoutMs: opts.timeoutMs });

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
