/**
 * Browser lifecycle benchmark: `iterations` create→connect→navigate→release
 * cycles per provider (concurrency 1 = sequential). Config lives here; all
 * orchestration is owned by @benchsdk/cli's runBenchmark.
 *
 * Run directly:
 *   tsx benchmarks/browser/browser.bench.ts
 *   tsx benchmarks/browser/browser.bench.ts --iterations 5 --provider browserbase
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmark, runBenchmark } from '@benchsdk/cli';
import { browserProviders } from './providers.js';
import { makeBrowserTask } from './browser-task.js';
import { writeBrowserLegacyResults } from './legacy-results.js';
import { exitOnBenchmarkError } from '../src/util/bench-exit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = defineBenchmark({
  benchmarkSlug: 'browser-local',
  benchmarkName: 'Browser (local)',
  benchmarkKind: 'browser',
  iterations: 2,
  concurrency: 1,
  task: makeBrowserTask(),
});

runBenchmark(config, browserProviders, process.argv.slice(2))
  .then(async (outcome) => {
    const resultsDir = path.resolve(__dirname, '../../results/browser');
    const timeoutMs = browserProviders.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;
    await writeBrowserLegacyResults(outcome.participants, { resultsDir, timeoutMs });
    process.exit(0);
  })
  .catch(exitOnBenchmarkError);
