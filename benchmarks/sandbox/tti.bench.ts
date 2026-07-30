/**
 * Sandbox time-to-interactive benchmark. TTI = sandbox create through the
 * first command (`node -v`) succeeding, excluding destroy. Declarative —
 * exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * One workload, three launch shapes — the only thing that differs is the
 * framework's own knobs, so they're CLI flags rather than separate files:
 *   sequential  one at a time (the config default: concurrency 1)
 *   burst       --concurrency N: all slots open at once, so this launches that
 *               many real sandboxes simultaneously — raise N deliberately
 *   staggered   --concurrency N --stagger-delay-ms D: task i starts at i * D
 * Each shape reports under its own platform benchmark via `--slug`/`--name`.
 *
 *   bench run benchmarks/sandbox/tti.bench.ts --iterations 5 --provider e2b,modal
 *   bench run benchmarks/sandbox/tti.bench.ts --slug sandbox-burst-local --name 'Sandbox burst TTI (local)' --iterations 10 --concurrency 10
 *   bench run benchmarks/sandbox/tti.bench.ts --slug sandbox-staggered-local --name 'Sandbox staggered TTI (local)' --iterations 10 --concurrency 10 --stagger-delay-ms 200
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { ResolvedRunConfig } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { providers } from './providers.js';
import type { BenchmarkMode, ProviderConfig } from './types.js';
import { writeSandboxLegacyResults } from './legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CREATE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const DESTROY_TIMEOUT_MS = 15_000;

/**
 * Which legacy result shape the run produced, derived from the knobs it
 * actually ran with. Legacy JSON labels a burst run 'concurrent' (see
 * merge-results / generate-svg) — that's also the shape carrying the
 * wall-clock/ramp fields — and leaves a sequential run untagged. The
 * `results/` directory names predate this file and are kept verbatim so the
 * SVG/README pipeline sees no rename.
 */
function legacyShape(run: ResolvedRunConfig): { resultsDir: string; mode?: BenchmarkMode } {
  if (run.staggerDelayMs > 0) return { resultsDir: 'staggered_tti', mode: 'staggered' };
  if (run.concurrency > 1) return { resultsDir: 'burst_tti', mode: 'concurrent' };
  return { resultsDir: 'sequential_tti' };
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'sandbox-tti-local',
  benchmarkName: 'Sandbox TTI (local)',
  benchmarkKind: 'sandbox',
  iterations: 2,
  concurrency: 1,
  participants: providers,
  onComplete: (outcome) => {
    const { resultsDir, mode } = legacyShape(outcome.config);
    return writeSandboxLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, `../../results/${resultsDir}`),
      mode,
      staggerDelayMs: outcome.config.staggerDelayMs,
    });
  },
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
