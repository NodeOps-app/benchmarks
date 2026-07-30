/**
 * Shared snapshot/fork workload for the snapshot-fork benchmark. One iteration:
 *   seed dataset -> snapshot -> fork(from snapshot) -> fork(from live) ->
 *   read-back-from-fork (verify) -> teardown.
 * Every created resource is torn down in a `finally` so a mid-iteration failure
 * does not leak real storage. Orchestration is owned by @benchsdk/runner's
 * runBenchmark — this file only describes what one iteration does.
 */
import crypto from 'node:crypto';
import type { Storage } from '@storagesdk/core';
import type { BenchmarkTask, TaskContext, TaskResult } from '@benchsdk/runner';
import { TaskError } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import type { StorageProviderConfig } from './types.js';
import type { DatasetPreset, DatasetSpec } from './snapshot-fork-types.js';

function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/** Best-effort cleanup that never throws — logs and swallows. */
async function safeCleanup(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await withTimeout(Promise.resolve(fn()), 30_000, `${label} timed out`);
  } catch (err) {
    console.warn(`    [cleanup] ${label} failed: ${formatError(err)}`);
  }
}

/**
 * Build a snapshot/fork task bound to a dataset preset. Caches one `Storage`
 * per participant name and a single random payload buffer (the legacy benchmark
 * created payload + storage once per provider).
 */
export function makeSnapshotForkTask(
  _dataset: DatasetPreset,
  spec: DatasetSpec,
): BenchmarkTask<StorageProviderConfig> {
  const storageCache = new Map<string, Storage>();
  const payload = crypto.randomBytes(spec.objectSizeBytes);
  const datasetBytes = spec.objectCount * spec.objectSizeBytes;

  return async function snapshotForkTask(ctx: TaskContext<StorageProviderConfig>): Promise<TaskResult> {
    const { participant, step } = ctx;
    const timeout = participant.timeout ?? 60_000;

    let storage = storageCache.get(participant.name);
    if (!storage) {
      storage = participant.createStorage();
      storageCache.set(participant.name, storage);
    }

    const runId = `${Date.now()}-${randomId()}`;
    const prefix = `snapfork/${runId}/`;
    const keys = Array.from({ length: spec.objectCount }, (_, i) => `${prefix}obj-${i}`);
    const snapshotName = `snap-${runId}`;
    const forkFromSnapName = `fork-snap-${runId}`;
    const forkFromLiveName = `fork-live-${runId}`;

    let snapshotId: string | undefined;
    let forkFromSnapCreated = false;
    let forkFromLiveCreated = false;

    try {
      const seedStart = performance.now();
      await step('seed', () =>
        withTimeout(Promise.all(keys.map((k) => storage!.upload(k, payload))), timeout, 'Seed upload timed out'),
      );
      const seedMs = performance.now() - seedStart;

      const snapStart = performance.now();
      const snapshot = await step<{ id: string }>('snapshot-create', () =>
        withTimeout(storage!.snapshots.create({ name: snapshotName }), timeout, 'Snapshot create timed out'),
      );
      const snapshotCreateMs = performance.now() - snapStart;
      snapshotId = snapshot.id;

      const forkSnapStart = performance.now();
      await step('fork-from-snapshot', () =>
        withTimeout(
          storage!.forks.create({ name: forkFromSnapName, fromSnapshot: snapshot.id }),
          timeout,
          'Fork-from-snapshot timed out',
        ),
      );
      const forkFromSnapshotMs = performance.now() - forkSnapStart;
      forkFromSnapCreated = true;

      const forkLiveStart = performance.now();
      await step('fork-from-live', () =>
        withTimeout(storage!.forks.create({ name: forkFromLiveName }), timeout, 'Fork-from-live timed out'),
      );
      const forkFromLiveMs = performance.now() - forkLiveStart;
      forkFromLiveCreated = true;

      const readStart = performance.now();
      const bytes = await step<{ length: number }>('fork-first-read', () =>
        withTimeout(
          storage!.forks.get(forkFromSnapName).download(keys[0], { as: 'bytes' }),
          timeout,
          'Fork read timed out',
        ),
      );
      const forkFirstReadMs = performance.now() - readStart;
      const verified = bytes.length === payload.length;

      return {
        data: {
          seedMs,
          snapshotCreateMs,
          forkFromSnapshotMs,
          forkFromLiveMs,
          forkFirstReadMs,
          verified,
          datasetBytes,
          objectCount: spec.objectCount,
        },
      };
    } catch (err) {
      const message = formatError(err);
      throw new TaskError(message, {
        code: 'SNAPSHOT_FORK_ERROR',
        data: {
          seedMs: 0,
          snapshotCreateMs: 0,
          forkFromSnapshotMs: 0,
          forkFromLiveMs: 0,
          forkFirstReadMs: 0,
          verified: false,
          datasetBytes,
          objectCount: spec.objectCount,
          errorMessage: message,
        },
      });
    } finally {
      if (forkFromSnapCreated) {
        await safeCleanup(`fork delete ${forkFromSnapName}`, () => storage!.forks.delete(forkFromSnapName));
      }
      if (forkFromLiveCreated) {
        await safeCleanup(`fork delete ${forkFromLiveName}`, () => storage!.forks.delete(forkFromLiveName));
      }
      if (snapshotId) {
        await safeCleanup(`snapshot delete ${snapshotId}`, () => storage!.snapshots.delete(snapshotId!));
      }
      await safeCleanup(`object delete ${prefix}*`, () => Promise.all(keys.map((k) => storage!.delete(k))));
    }
  };
}
