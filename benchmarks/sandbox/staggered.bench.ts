/**
 * Staggered TTI benchmark: `iterations` sandboxes launched with all pool
 * slots available (concurrency == iterations), task N starting at
 * `N * staggerDelayMs` after the worker begins, producing a ramp. Declarative —
 * exports `config` + `task`; `bench run` owns the entrypoint. Sanity-check the
 * resulting ramp on the dashboard.
 *
 *   bench run benchmarks/sandbox/staggered.bench.ts
 *   bench run benchmarks/sandbox/staggered.bench.ts --iterations 10 --concurrency 10 --stagger-delay-ms 200
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
  benchmarkSlug: 'sandbox-staggered-local',
  benchmarkName: 'Sandbox staggered TTI (local)',
  benchmarkKind: 'sandbox',
  iterations: 3,
  concurrency: 3,
  staggerDelayMs: 200,
  participants: providers,
  onComplete: (outcome) =>
    writeSandboxLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/staggered_tti'),
      mode: 'staggered',
      staggerDelayMs: outcome.config.staggerDelayMs,
    }),
});

export const task = defineTask(ttiTask);
