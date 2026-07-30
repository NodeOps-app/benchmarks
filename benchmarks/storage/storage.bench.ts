/**
 * Storage upload/download benchmark: `iterations` upload→download→delete cycles
 * per provider (concurrency 1 = sequential). Config lives here; all
 * orchestration is owned by @benchsdk/cli's runBenchmark.
 *
 * Run directly:
 *   tsx benchmarks/storage/storage.bench.ts
 *   tsx benchmarks/storage/storage.bench.ts --file-size 10MB --iterations 5 --provider aws-s3
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { defineBenchmark, runBenchmark } from '@benchsdk/cli';
import { storageProviders } from './providers.js';
import { makeStorageTask } from './storage-task.js';
import { writeStorageLegacyResults } from './legacy-results.js';
import { FILE_SIZE_BYTES } from './types.js';
import type { StorageFileSize } from './types.js';
import { exitOnBenchmarkError } from '../src/util/bench-exit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --file-size is unknown to @benchsdk/cli and passes through untouched, so we
// parse it ourselves from process.argv (default '10MB', matching run.ts).
const args = process.argv.slice(2);
function getArgValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}
const fileSizeArg = getArgValue(args, '--file-size') ?? '10MB';
const validSizes = Object.keys(FILE_SIZE_BYTES) as StorageFileSize[];
if (!(fileSizeArg in FILE_SIZE_BYTES)) {
  console.error(`Invalid --file-size "${fileSizeArg}". Valid sizes: ${validSizes.join(', ')}`);
  process.exit(1);
}
const fileSizeLabel = fileSizeArg as StorageFileSize;
const fileSizeBytes = FILE_SIZE_BYTES[fileSizeLabel];

const testData = crypto.randomBytes(fileSizeBytes);

const config = defineBenchmark({
  benchmarkSlug: 'storage-local',
  benchmarkName: 'Storage (local)',
  benchmarkKind: 'storage',
  iterations: 2,
  concurrency: 1,
  task: makeStorageTask(testData, fileSizeBytes),
});

runBenchmark(config, storageProviders, process.argv.slice(2))
  .then(async (outcome) => {
    const resultsDir = path.resolve(__dirname, `../../results/storage/${fileSizeLabel.toLowerCase()}`);
    await writeStorageLegacyResults(outcome.participants, {
      resultsDir,
      fileSizeBytes,
      providers: storageProviders,
    });
    process.exit(0);
  })
  .catch(exitOnBenchmarkError);
