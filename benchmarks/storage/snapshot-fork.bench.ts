/**
 * Storage snapshot/fork benchmark: per-iteration seed -> snapshot -> fork ->
 * verify, per provider (concurrency 1 = sequential; each iteration creates real
 * snapshots/forks). Config lives here; orchestration is owned by @benchsdk/runner's
 * runBenchmark.
 *
 *   bench run benchmarks/storage/snapshot-fork.bench.ts
 *   bench run benchmarks/storage/snapshot-fork.bench.ts --dataset wide --iterations 5 --provider tigris
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { storageProviders } from './providers.js';
import { makeSnapshotForkTask } from './snapshot-fork-task.js';
import { writeSnapshotForkLegacyResults } from './snapshot-fork-legacy-results.js';
import { DATASET_PRESETS } from './snapshot-fork-types.js';
import type { DatasetPreset } from './snapshot-fork-types.js';
import type { StorageProviderConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --dataset is unknown to @benchsdk/runner and passes through untouched, so we
// parse it ourselves from process.argv (default 'small', matching run.ts).
const args = process.argv.slice(2);
function getArgValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}
const datasetArg = getArgValue(args, '--dataset') ?? 'small';
const validDatasets = Object.keys(DATASET_PRESETS) as DatasetPreset[];
if (!(datasetArg in DATASET_PRESETS)) {
  console.error(`Invalid --dataset "${datasetArg}". Valid datasets: ${validDatasets.join(', ')}`);
  process.exit(1);
}
const dataset = datasetArg as DatasetPreset;
const spec = DATASET_PRESETS[dataset];

// Some providers need a different bucket/credentials for snapshot-fork than for
// upload/download (e.g. Tigris's snapshot-enabled bucket); apply that override
// here, mirroring run.ts's runSnapshotFork.
const participants: StorageProviderConfig[] = storageProviders.map((p) => {
  const { snapshotFork, ...base } = p;
  return snapshotFork ? { ...base, ...snapshotFork } : base;
});

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'snapshot-fork-local',
  benchmarkName: 'Snapshot/Fork (local)',
  benchmarkKind: 'storage',
  iterations: 2,
  concurrency: 1,
  participants,
  onComplete: (outcome) =>
    writeSnapshotForkLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, `../../results/snapshot-fork/${dataset}`),
      dataset,
      spec,
      providers: participants,
    }),
});

export const task = defineTask(makeSnapshotForkTask(dataset, spec));
