/**
 * Sequential TTI benchmark: `iterations` sandboxes created one at a time
 * (concurrency 1) per provider, each measuring time-to-interactive. This file
 * is declarative — it exports a `config` and a `task`; the CLI (`bench run`)
 * owns the entrypoint and CLI flags override the config knobs.
 *
 *   bench run benchmarks/sandbox/sequential.bench.ts
 *   bench run benchmarks/sandbox/sequential.bench.ts --iterations 5 --provider e2b,modal
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
  benchmarkSlug: 'sandbox-tti-local',
  benchmarkName: 'Sandbox TTI (local)',
  benchmarkKind: 'sandbox',
  iterations: 2,
  concurrency: 1,
  participants: providers,
  onComplete: (outcome) =>
    writeSandboxLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/sequential_tti'),
    }),
});

export const task = defineTask(ttiTask);
