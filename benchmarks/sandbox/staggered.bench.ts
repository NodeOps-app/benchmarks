/**
 * Staggered TTI benchmark: `iterations` sandboxes launched with all pool
 * slots available (concurrency == iterations), task N starting at
 * `N * staggerDelayMs` after the worker begins, producing a ramp. Config
 * lives here; the stagger and all other orchestration are owned by
 * @benchsdk/cli's runBenchmark. Sanity-check the resulting ramp on the
 * dashboard.
 *
 * Run directly:
 *   tsx benchmarks/sandbox/staggered.bench.ts
 *   tsx benchmarks/sandbox/staggered.bench.ts --iterations 10 --concurrency 10 --stagger-delay-ms 200
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmark, runBenchmark } from '@benchsdk/cli';
import { providers } from './providers.js';
import { ttiTask, logTti } from './tti-task.js';
import { writeSandboxLegacyResults } from './legacy-results.js';
import { exitOnBenchmarkError } from '../src/util/bench-exit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = defineBenchmark({
  benchmarkSlug: 'sandbox-staggered-local',
  benchmarkName: 'Sandbox staggered TTI (local)',
  benchmarkKind: 'sandbox',
  iterations: 3,
  concurrency: 3,
  staggerDelayMs: 200,
  task: ttiTask,
  onResult: logTti,
});

runBenchmark(config, providers, process.argv.slice(2))
  .then(async (outcome) => {
    const resultsDir = path.resolve(__dirname, '../../results/staggered_tti');
    await writeSandboxLegacyResults(outcome.participants, {
      resultsDir,
      mode: 'staggered',
      staggerDelayMs: outcome.config.staggerDelayMs,
    });
    process.exit(0);
  })
  .catch(exitOnBenchmarkError);
