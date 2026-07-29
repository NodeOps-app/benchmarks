/**
 * Shared time-to-interactive workload for the sequential / burst / staggered
 * benchmarks. TTI = sandbox create through the first command (`node -v`)
 * succeeding, excluding destroy. Orchestration (how many, how parallel, how
 * staggered) is owned by @benchsdk/cli's runBenchmark — this file only
 * describes what one iteration does.
 */
import type { TaskContext, TaskResult } from '@benchsdk/cli';
import type { JsonObject } from '@benchsdk/client';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import type { ProviderConfig } from './types.js';

const CREATE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const DESTROY_TIMEOUT_MS = 15_000;

export async function ttiTask(ctx: TaskContext<ProviderConfig>): Promise<TaskResult> {
  const { participant, step } = ctx;
  const compute = participant.createCompute();

  const start = performance.now();
  const sandbox = await step<any>('create', () =>
    withTimeout(
      compute.sandbox.create(participant.sandboxOptions),
      participant.timeout ?? CREATE_TIMEOUT_MS,
      'Sandbox creation timed out',
    ),
  );

  try {
    await step('exec.task', async () => {
      const result = (await withTimeout(
        sandbox.runCommand('node -v'),
        COMMAND_TIMEOUT_MS,
        'First command execution timed out',
      )) as { exitCode: number; stderr?: string };
      if (result.exitCode !== 0) {
        throw new Error(`Command failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
      }
    });
    return { data: { ttiMs: performance.now() - start } };
  } finally {
    await step('destroy', () =>
      withTimeout(sandbox.destroy(), participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS, 'Destroy timeout'),
      { reportConcurrency: false },
    ).catch((err) => console.warn(`    [cleanup] destroy failed: ${formatError(err)}`));
  }
}

/** Shared per-record logger that renders TTI in seconds. */
export function logTti(record: { taskIndex: number; status: string; errorCode?: string | null; data?: JsonObject }, meta: { iterations: number }): void {
  const n = record.taskIndex + 1;
  if (record.status === 'success') {
    const ttiMs = typeof record.data?.ttiMs === 'number' ? record.data.ttiMs : undefined;
    console.log(`  Task ${n}/${meta.iterations}: TTI ${ttiMs !== undefined ? (ttiMs / 1000).toFixed(2) + 's' : '--'}`);
  } else {
    console.log(`  Task ${n}/${meta.iterations}: FAILED — ${record.errorCode ?? 'unknown error'}`);
  }
}
