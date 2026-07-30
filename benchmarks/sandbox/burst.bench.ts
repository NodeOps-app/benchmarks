/**
 * Burst TTI benchmark: `iterations` sandboxes all launched at once
 * (concurrency == iterations) per provider, each measuring time-to-
 * interactive. Config lives here; orchestration is owned by @benchsdk/cli's
 * runBenchmark. Keep the numbers small and raise deliberately — this launches
 * that many real sandboxes simultaneously.
 *
 * Run directly:
 *   tsx benchmarks/sandbox/burst.bench.ts
 *   tsx benchmarks/sandbox/burst.bench.ts --iterations 10 --concurrency 10 --provider e2b
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
  benchmarkSlug: 'sandbox-burst-local',
  benchmarkName: 'Sandbox burst TTI (local)',
  benchmarkKind: 'sandbox',
  iterations: 3,
  concurrency: 3,
  task: ttiTask,
  onResult: logTti,
});

runBenchmark(config, providers, process.argv.slice(2))
  .then(async (outcome) => {
    const resultsDir = path.resolve(__dirname, '../../results/burst_tti');
    // Legacy JSON labels burst results 'concurrent' (see merge-results /
    // generate-svg), which is also the shape that carries the wall-clock fields.
    await writeSandboxLegacyResults(outcome.participants, { resultsDir, mode: 'concurrent' });
    process.exit(0);
  })
  .catch(exitOnBenchmarkError);
