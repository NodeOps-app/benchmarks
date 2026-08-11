/**
 * Sandbox time-to-interactive benchmark. TTI = sandbox create through the
 * first command (`node -v`) succeeding, excluding destroy. Declarative —
 * exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * Burst shape only: --concurrency N opens all slots at once, launching that
 * many real sandboxes simultaneously — raise N deliberately.
 *
 *   bench run benchmarks/sandbox/tti.bench.ts --iterations 10 --concurrency 10 --provider e2b,modal
 *
 * To rank providers against each other, run each provider with the same
 * `--run-key`: they get-or-create one shared run and each claims its own worker.
 *
 *   bench run benchmarks/sandbox/tti.bench.ts --provider e2b   --run-key "$GITHUB_RUN_ID"
 *   bench run benchmarks/sandbox/tti.bench.ts --provider modal --run-key "$GITHUB_RUN_ID"
 *
 * Sequential and staggered shapes were retired (2026-08-11): results/sequential_tti
 * and results/staggered_tti keep their historic data but are no longer written to.
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { writeSandboxLegacyResults } from './legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CREATE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const DESTROY_TIMEOUT_MS = 15_000;

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'sandbox-tti',
  benchmarkName: 'Sandbox TTI (Burst)',
  benchmarkKind: 'sandbox',
  iterations: 2,
  concurrency: 1,
  participants: providers,
  // Legacy JSON labels a burst run 'concurrent' (see merge-results /
  // generate-svg) — that's the shape carrying the wall-clock/ramp fields. The
  // `results/` directory name predates this file and is kept verbatim so the
  // SVG/README pipeline sees no rename.
  onComplete: (outcome) =>
    writeSandboxLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/burst_tti'),
      mode: 'concurrent',
    }),
});

/** The slice of a provider's sandbox this workload actually touches. */
interface TtiSandbox {
  runCommand(command: string): Promise<{ exitCode: number; stderr?: string }>;
  destroy(): Promise<unknown>;
}

export const task = defineTask<ProviderConfig>(async (ctx) => {
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
      const result = await withTimeout(
        sandbox.runCommand('node -v'),
        COMMAND_TIMEOUT_MS,
        'First command execution timed out',
      );
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
});
