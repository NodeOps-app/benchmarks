/**
 * Browser throughput benchmark: each session runs a fixed action loop; sessions
 * are interleaved across providers (groupBy 'round') so every provider runs its
 * Nth session against the same article before anyone starts their (N+1)th.
 * Config lives here; orchestration is owned by @benchsdk/cli's runBenchmark.
 *
 * Run directly:
 *   tsx benchmarks/browser/browser-throughput.bench.ts
 *   tsx benchmarks/browser/browser-throughput.bench.ts --iterations 5 --provider browserbase
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmark, runBenchmark } from '@benchsdk/cli';
import { throughputProviders } from './throughput-providers.js';
import { makeThroughputTask } from './browser-throughput-task.js';
import { writeThroughputLegacyResults } from './browser-throughput-legacy-results.js';
import { exitOnBenchmarkError } from '../src/util/bench-exit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = defineBenchmark({
  benchmarkSlug: 'browser-throughput-local',
  benchmarkName: 'Browser Throughput (local)',
  benchmarkKind: 'browser',
  iterations: 2,
  groupBy: 'round',
  task: makeThroughputTask(),
});

runBenchmark(config, throughputProviders, process.argv.slice(2))
  .then(async (outcome) => {
    const resultsDir = path.resolve(__dirname, '../../results/browser-throughput');
    const timeoutMs = throughputProviders.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;
    await writeThroughputLegacyResults(outcome.participants, { resultsDir, timeoutMs });
    process.exit(0);
  })
  .catch(exitOnBenchmarkError);
