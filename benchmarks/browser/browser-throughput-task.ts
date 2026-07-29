/**
 * Shared throughput workload for the browser-throughput benchmark. One task =
 * one session running the fixed 10-action loop (navigate, waitForSelector,
 * screenshot, textContent, click, goBack, ...). Reuses the legacy
 * `runThroughputIteration` verbatim so per-action timings/results are identical;
 * this file only adapts that into the CLI's task/TaskResult shape.
 *
 * Runs under `groupBy: 'round'` so every provider runs its Nth session against
 * the same article URL (via navUrlForIteration(taskIndex)) before anyone starts
 * their (N+1)th — matching the legacy interleaved throughput benchmark.
 */
import type { BenchmarkTask, TaskContext, TaskResult } from '@benchsdk/cli';
import { TaskError } from '@benchsdk/cli';
import type { JsonValue } from '@benchsdk/client';
import { navUrlForIteration, runThroughputIteration } from './throughput-benchmark.js';
import type { ThroughputProviderConfig } from './throughput-types.js';

/** Build a throughput task caching one provider instance per participant name. */
export function makeThroughputTask(): BenchmarkTask<ThroughputProviderConfig> {
  const providerCache = new Map<string, any>();

  return async function throughputTask(ctx: TaskContext<ThroughputProviderConfig>): Promise<TaskResult> {
    const { participant, taskIndex } = ctx;
    const timeout = participant.timeout ?? 120_000;
    const sessionCreateOptions = participant.sessionCreateOptions ?? {};

    let provider = providerCache.get(participant.name);
    if (!provider) {
      provider = participant.createBrowserProvider();
      providerCache.set(participant.name, provider);
    }

    const navigateUrl = navUrlForIteration(taskIndex);
    const result = await runThroughputIteration(provider, timeout, sessionCreateOptions, navigateUrl);

    const data = {
      createMs: result.createMs,
      connectMs: result.connectMs,
      releaseMs: result.releaseMs,
      totalMs: result.totalMs,
      taskMs: result.taskMs,
      actionsCompleted: result.actionsCompleted,
      actionsPerSecond: result.actionsPerSecond,
      actions: result.actions as unknown as JsonValue,
      ...(result.error ? { errorMessage: result.error } : {}),
    };

    // A session-level failure (create/connect/etc.) is a task error. Partial
    // action completion is NOT an error — it's a success record with
    // actionsCompleted < ACTIONS_PER_SESSION, exactly as the legacy runner did.
    if (result.error) {
      throw new TaskError(result.error, { code: 'THROUGHPUT_ERROR', data });
    }
    return { data };
  };
}
