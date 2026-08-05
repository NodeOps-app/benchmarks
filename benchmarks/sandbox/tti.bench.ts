/**
 * Sandbox time-to-interactive benchmark. TTI = sandbox create through the
 * first command (`node -v`) succeeding, excluding destroy. Declarative —
 * exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * One workload, three launch shapes. Each shape is its own platform benchmark
 * but the same task, so they're declared once in `shapes` and picked with
 * `--shape`; the scale knobs (`--iterations`/`--concurrency`) stay on the CLI:
 *   sequential  the base config (concurrency 1) — no `--shape`
 *   burst       --concurrency N: all slots open at once, launching that many
 *               real sandboxes simultaneously — raise N deliberately
 *   staggered   its 200ms delay is baked into the shape; task i starts at i * D
 *
 *   bench run benchmarks/sandbox/tti.bench.ts --iterations 5 --provider e2b,modal
 *   bench run benchmarks/sandbox/tti.bench.ts --shape burst --iterations 10 --concurrency 10
 *   bench run benchmarks/sandbox/tti.bench.ts --shape staggered --iterations 10 --concurrency 10
 *
 * To rank providers against each other, run each provider with the same
 * `--run-key`: they get-or-create one shared run and each claims its own worker.
 *
 *   bench run benchmarks/sandbox/tti.bench.ts --shape burst --provider e2b   --run-key "$GITHUB_RUN_ID"
 *   bench run benchmarks/sandbox/tti.bench.ts --shape burst --provider modal --run-key "$GITHUB_RUN_ID"
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
  // The launch shapes: same task, distinct platform identities. `--shape burst`
  // just swaps the slug/name — the caller brings `--concurrency`. Staggered
  // also carries its defining 200ms delay so no caller has to remember it.
  shapes: {
    burst: { slug: 'sandbox-burst-local', name: 'Sandbox burst TTI (local)' },
    staggered: { slug: 'sandbox-staggered-local', name: 'Sandbox staggered TTI (local)', staggerDelayMs: 200 },
  },
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
