/**
 * Shared time-to-interactive workload for the sequential / burst / staggered
 * benchmarks. TTI = sandbox create through the first command (`node -v`)
 * succeeding, excluding destroy. Orchestration (how many, how parallel, how
 * staggered) is owned by @benchsdk/runner — this file only describes what one
 * iteration does and reports `ttiMs` via `ctx.measure`.
 */
import type { TaskContext } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import type { ProviderConfig } from './types.js';

const CREATE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const DESTROY_TIMEOUT_MS = 15_000;

/** The slice of a provider's sandbox this workload actually touches. */
interface TtiSandbox {
  runCommand(command: string): Promise<{ exitCode: number; stderr?: string }>;
  destroy(): Promise<unknown>;
}

export async function ttiTask(ctx: TaskContext<ProviderConfig>): Promise<void> {
  const { participant, step, measure } = ctx;
  const compute = participant.createCompute();

  const start = performance.now();
  const sandbox = await step('create', () =>
    withTimeout<TtiSandbox>(
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
    measure({ ttiMs: performance.now() - start });
  } finally {
    await step('destroy', () =>
      withTimeout(sandbox.destroy(), participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS, 'Destroy timeout'),
      { reportConcurrency: false },
    ).catch((err) => console.warn(`    [cleanup] destroy failed: ${formatError(err)}`));
  }
}
