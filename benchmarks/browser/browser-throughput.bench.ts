/**
 * Browser throughput benchmark: each session runs a fixed action loop; sessions
 * are interleaved across providers (groupBy 'round') so every provider runs its
 * Nth session against the same article before anyone starts their (N+1)th.
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 *   bench run benchmarks/browser/browser-throughput.bench.ts
 *   bench run benchmarks/browser/browser-throughput.bench.ts --iterations 5 --provider browserbase
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { throughputProviders } from './throughput-providers.js';
import { makeThroughputTask } from './browser-throughput-task.js';
import { writeThroughputLegacyResults } from './browser-throughput-legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const throughputTimeoutMs =
  throughputProviders.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'browser-throughput-local',
  benchmarkName: 'Browser Throughput (local)',
  benchmarkKind: 'browser',
  iterations: 2,
  groupBy: 'round',
  participants: throughputProviders,
  onComplete: (outcome) =>
    writeThroughputLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/browser-throughput'),
      timeoutMs: throughputTimeoutMs,
    }),
});

export const task = defineTask(makeThroughputTask());
