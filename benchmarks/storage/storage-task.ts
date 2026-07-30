/**
 * Shared storage upload/download workload for the storage benchmark. One
 * iteration = upload a buffer, download it, compute throughput, then delete
 * (best-effort cleanup). Orchestration (how many, how parallel) is owned by
 * @benchsdk/cli's runBenchmark — this file only describes what one iteration
 * does.
 */
import type { BenchmarkTask, TaskContext, TaskResult } from '@benchsdk/cli';
import { TaskError } from '@benchsdk/cli';
import type { Storage } from '@storagesdk/core';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import type { StorageProviderConfig } from './types.js';

function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/**
 * Build a storage task bound to a shared test buffer + file size. The factory
 * caches one `Storage` instance per participant name inside its closure so the
 * adapter (and its credentials lookup) isn't recreated on every iteration —
 * the legacy benchmark created storage once per provider; this preserves that
 * behavior while keeping the per-iteration task signature the CLI expects.
 */
export function makeStorageTask(
  testData: Buffer,
  fileSizeBytes: number,
): BenchmarkTask<StorageProviderConfig> {
  const storageCache = new Map<string, Storage>();

  return async function storageTask(ctx: TaskContext<StorageProviderConfig>): Promise<TaskResult> {
    const { participant, step } = ctx;
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

      // Download timing — request raw bytes so we measure a full object fetch
      const downloadStart = performance.now();
      await step('download', () =>
        withTimeout(storage!.download(key, { as: 'bytes' }), timeout, 'Download timed out'),
      );
      const downloadMs = performance.now() - downloadStart;

      // Throughput in Mbps (download-side)
      const throughputMbps = (fileSizeBytes * 8) / (downloadMs / 1000) / 1_000_000;

      // Cleanup: best-effort delete; failures are warned but don't fail the task.
      await step(
        'delete',
        () => withTimeout(storage!.delete(key), 10_000, 'Delete timed out'),
        { reportConcurrency: false },
      ).catch((err) => console.warn(`    [cleanup] delete failed: ${formatError(err)}`));

      return { data: { uploadMs, downloadMs, throughputMbps, fileSizeBytes } };
    } catch (err) {
      // Attempt cleanup even on failure (best-effort, mirrors legacy catch).
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
  };
}
