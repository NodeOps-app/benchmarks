/**
 * Burst TTI benchmark: `iterations` sandboxes all launched at once
 * (concurrency == iterations) per provider, each measuring time-to-
 * interactive. Declarative — exports `config` + `task`; `bench run` owns the
 * entrypoint. Keep the numbers small and raise deliberately — this launches
 * that many real sandboxes simultaneously.
 *
 *   bench run benchmarks/sandbox/burst.bench.ts
 *   bench run benchmarks/sandbox/burst.bench.ts --iterations 10 --concurrency 10 --provider e2b
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { providers } from './providers.js';
import { ttiTask } from './tti-task.js';
import { writeSandboxLegacyResults } from './legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'sandbox-burst-local',
  benchmarkName: 'Sandbox burst TTI (local)',
  benchmarkKind: 'sandbox',
  iterations: 3,
  concurrency: 3,
  participants: providers,
  // Legacy JSON labels burst results 'concurrent' (see merge-results /
  // generate-svg), which is also the shape that carries the wall-clock fields.
  onComplete: (outcome) =>
    writeSandboxLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/burst_tti'),
      mode: 'concurrent',
    }),
});

export const task = defineTask(ttiTask);
