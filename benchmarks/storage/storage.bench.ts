/**
 * Storage upload/download benchmark: `iterations` upload→download→delete cycles
 * per provider (concurrency 1 = sequential). Declarative — exports `config` +
 * `task`; `bench run` owns the entrypoint. The custom `--file-size` flag is
 * scanned from argv here (the runner ignores flags it doesn't know).
 *
 *   bench run benchmarks/storage/storage.bench.ts
 *   bench run benchmarks/storage/storage.bench.ts --file-size 10MB --iterations 5 --provider aws-s3
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { storageProviders } from './providers.js';
import { makeStorageTask } from './storage-task.js';
import { writeStorageLegacyResults } from './legacy-results.js';
import { FILE_SIZE_BYTES } from './types.js';
import type { StorageFileSize } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --file-size is unknown to @benchsdk/runner and passes through untouched, so we
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

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'storage-local',
  benchmarkName: 'Storage (local)',
  benchmarkKind: 'storage',
  iterations: 2,
  concurrency: 1,
  participants: storageProviders,
  onComplete: (outcome) =>
    writeStorageLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, `../../results/storage/${fileSizeLabel.toLowerCase()}`),
      fileSizeBytes,
      providers: storageProviders,
    }),
});

export const task = defineTask(makeStorageTask(testData, fileSizeBytes));
