/**
 * Dax benchmark: runs the OpenCode build (scripts/dax-benchmark.sh) inside a
 * freshly created sandbox once per iteration and measures its build phases
 * (prepare / bun-download / bun-unpack / clone / install / typecheck). Config
 * lives here; platform orchestration is owned by @benchsdk/runner's runBenchmark.
 * The phase-parsing + resource-sizing logic is reused from ./dax.ts so the
 * legacy `results/sandbox-dax/` JSON shape is preserved verbatim via the
 * legacy-results adapter (TEMPORARY local-JSON bridge — see legacy-results).
 *
 * `groupBy: 'round'` is used so the task owns its own measured `latencyMs`
 * (the build's totalMs) and can attach pre-measured phase steps; the local
 * bridge reconstructs the full DaxTimingResult from `record.data`.
 *
 * Run:
 *   bench run benchmarks/sandbox/dax.bench.ts
 *   bench run benchmarks/sandbox/dax.bench.ts --provider e2b,modal
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { TaskContext, TaskResult } from '@benchsdk/runner';
import type { JsonObject, TaskStepRecord } from '@benchsdk/client';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { getSandboxOptionsWithResources, runDaxIteration } from './dax.js';
import type { DaxTimingResult } from './dax.js';
import { writeDaxLegacyResults } from './dax-legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const timeout = 600_000;
const destroyTimeoutMs = 15_000;

/** Emit each measured build phase as a pre-measured platform step. */
function daxPhaseSteps(t: DaxTimingResult): TaskStepRecord[] {
  const phases: [string, number | undefined][] = [
    ['prepare', t.prepareMs],
    ['cache_clear', t.cacheClearMs],
    ['bun_download', t.bunDownloadMs],
    ['bun_unpack', t.bunUnpackMs],
    ['clone', t.cloneMs],
    ['install', t.installMs],
    ['typecheck', t.typecheckMs],
  ];
  return phases
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([name, latencyMs]) => ({ name, status: 'success', latencyMs }));
}

async function daxTask(ctx: TaskContext<ProviderConfig>): Promise<TaskResult> {
  const p = ctx.participant;
  const compute = p.createCompute();
  const opts = getSandboxOptionsWithResources(p.name, p.sandboxOptions);

  const sandbox = await ctx.step('create', () =>
    withTimeout<{ destroy(): Promise<unknown> }>(
      compute.sandbox.create(opts),
      p.timeout ?? timeout,
      'Sandbox creation timed out',
    ),
  );

  let timing: DaxTimingResult;
  try {
    timing = await ctx.step('build', () => runDaxIteration(sandbox, p.name, p.timeout ?? timeout));
  } finally {
    await ctx
      .step('destroy', () => withTimeout(sandbox.destroy(), p.destroyTimeoutMs ?? destroyTimeoutMs, 'Destroy timeout'), {
        reportConcurrency: false,
      })
      .catch((err) => console.warn(`    [cleanup] destroy failed: ${formatError(err)}`));
  }

  const data = timing as unknown as JsonObject;
  const steps = daxPhaseSteps(timing);

  if (timing.error) {
    throw new TaskError(timing.error, { code: 'dax_failed', data, steps });
  }
  return { data, steps, latencyMs: timing.totalMs };
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'sandbox-dax-local',
  benchmarkName: 'Dax sandbox benchmark (local)',
  benchmarkKind: 'sandbox',
  iterations: 3,
  concurrency: 1,
  groupBy: 'round',
  defaultProviders: ['e2b', 'modal', 'tensorlake'],
  participants: providers,
  onComplete: (outcome) =>
    writeDaxLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/sandbox-dax'),
    }),
});

export const task = defineTask(daxTask);
