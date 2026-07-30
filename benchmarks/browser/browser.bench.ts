/**
 * Browser lifecycle benchmark: `iterations` create→connect→navigate→release
 * cycles per provider (concurrency 1 = sequential). Declarative — exports
 * `config` + `task`; `bench run` owns the entrypoint.
 *
 *   bench run benchmarks/browser/browser.bench.ts
 *   bench run benchmarks/browser/browser.bench.ts --iterations 5 --provider browserbase
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { browserProviders } from './providers.js';
import { makeBrowserTask } from './browser-task.js';
import { writeBrowserLegacyResults } from './legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const browserTimeoutMs = browserProviders.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'browser-local',
  benchmarkName: 'Browser (local)',
  benchmarkKind: 'browser',
  iterations: 2,
  concurrency: 1,
  participants: browserProviders,
  onComplete: (outcome) =>
    writeBrowserLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/browser'),
      timeoutMs: browserTimeoutMs,
    }),
});

export const task = defineTask(makeBrowserTask());
