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
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { Storage } from '@storagesdk/core';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { storageProviders } from './providers.js';
import { writeStorageLegacyResults } from './legacy-results.js';
import { FILE_SIZE_BYTES } from './types.js';
import type { StorageFileSize, StorageProviderConfig } from './types.js';

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
  benchmarkSlug: 'storage-lifecycle',
  benchmarkName: 'Storage Lifecycle',
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

function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/**
 * One `Storage` instance per participant, so the adapter (and its credentials
 * lookup) isn't recreated on every iteration.
 */
const storageCache = new Map<string, Storage>();

export const task = defineTask<StorageProviderConfig>(async (ctx) => {
  const { participant, step, measure } = ctx;
  const timeout = participant.timeout ?? 30_000;

  let storage = storageCache.get(participant.name);
  if (!storage) {
    storage = participant.createStorage();
    storageCache.set(participant.name, storage);
  }

  const key = `benchmark-${Date.now()}-${randomId()}`;

  try {
    // Upload timing
    const uploadStart = performance.now();
    await step('upload', () =>
      withTimeout(storage!.upload(key, testData), timeout, 'Upload timed out'),
    );
    const uploadMs = performance.now() - uploadStart;

    // Download timing — request raw bytes so we measure a full object fetch.
    // Throughput (Mbps) is a rate, not a duration, so it can't be inferred
    // from the step's latency; measure it inside the `download` step so it
    // lands on that step's data (platform step_data_json).
    let downloadMs = 0;
    let throughputMbps = 0;
    await step('download', async () => {
      const downloadStart = performance.now();
      await withTimeout(storage!.download(key, { as: 'bytes' }), timeout, 'Download timed out');
      downloadMs = performance.now() - downloadStart;
      throughputMbps = (fileSizeBytes * 8) / (downloadMs / 1000) / 1_000_000;
      measure({ throughputMbps });
    });

    // Cleanup: best-effort delete; failures are warned but don't fail the task.
    await step(
      'delete',
      () => withTimeout(storage!.delete(key), 10_000, 'Delete timed out'),
      { reportConcurrency: false },
    ).catch((err) => console.warn(`    [cleanup] delete failed: ${formatError(err)}`));

    return { data: { uploadMs, downloadMs, throughputMbps, fileSizeBytes } };
  } catch (err) {
    // Attempt cleanup even on failure.
    try {
      await withTimeout(storage!.delete(key), 10_000, 'Delete timed out');
    } catch {
      // Ignore cleanup errors on the failure path.
    }
    const message = formatError(err);
    throw new TaskError(message, {
      code: 'STORAGE_ERROR',
      data: { uploadMs: 0, downloadMs: 0, throughputMbps: 0, fileSizeBytes },
    });
  }
});
