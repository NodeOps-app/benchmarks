/**
 * A `*.bench.ts` file is the composition of a **config** and a **task**:
 *
 *   export const config = defineBenchmarkConfig({ benchmarkSlug, participants, ... });
 *   export const task = defineTask(async (ctx) => { await ctx.step('work', () => ...); });
 *
 * `defineBenchmarkConfig` holds the orchestration knobs (including the
 * participants and an optional `onComplete` hook); `defineTask` holds the
 * workload. The `bench run <file>` binary imports the module, reads those two
 * exports, and drives the run. There is no "mode": all orchestration shapes
 * emerge from the knobs.
 *
 *   iterations       total tasks to run (default 1)
 *   concurrency      max tasks in flight at once — 1 = sequential, N = burst (default 1)
 *   staggerDelayMs   delay each task's start by taskIndex * staggerDelayMs (default 0)
 *
 * Common shapes:
 *   sequential  { iterations: N, concurrency: 1 }
 *   burst       { iterations: N, concurrency: N }
 *   staggered   { iterations: N, concurrency: N, staggerDelayMs: 200 }
 *
 * A task is comprised of steps, declared via `ctx.step` inside a task function
 * — it supports closures, conditionals and try/finally, so values (a created
 * sandbox, say) flow naturally between steps. A task that declares no steps is
 * recorded as a single implicit `task` step. Measurements reach the platform
 * via `ctx.measure(...)`; step return values are control flow and never
 * recorded.
 */
import type {
  BaseParticipant,
  DefineStepOptions,
  JsonObject,
  TaskResultRecord,
  TaskStepRecord,
} from '@benchsdk/client';

/** How tasks are ordered across participants. */
export type GroupBy = 'participant' | 'round';

/**
 * What a task returns: whatever it measured itself. This replaces the
 * assumption that the framework owns all timing. A plain data payload is
 * written explicitly as `{ data: {...} }`.
 */
export interface TaskResult {
  /** Free-form domain payload attached to the record (tokens, receipts, ...). */
  data?: JsonObject;
  /**
   * Pre-measured steps the task timed itself (e.g. socket phases).
   * Only honored in `groupBy: 'round'` runs, where the runner builds records
   * manually. In `groupBy: 'participant'` runs the platform worker
   * (`client.runWorker`) owns steps, so `steps` and `latencyMs` are ignored.
   */
  steps?: TaskStepRecord[];
  /** Task-owned overall latency; overrides framework wall-clock (round mode only). */
  latencyMs?: number;
}

/**
 * Throw this from a task to record a failure while preserving domain data and
 * any pre-measured steps (a plain thrown Error loses them).
 */
export class TaskError extends Error {
  readonly code?: string;
  readonly data?: JsonObject;
  readonly steps?: TaskStepRecord[];
  constructor(message: string, opts?: { code?: string; data?: JsonObject; steps?: TaskStepRecord[] }) {
    super(message);
    this.name = 'TaskError';
    this.code = opts?.code;
    this.data = opts?.data;
    this.steps = opts?.steps;
  }
}

/** Context handed to a benchmark `task` for a single iteration. */
export interface TaskContext<T extends BaseParticipant = BaseParticipant> {
  /** The participant this task is running for. */
  participant: T;
  /** Zero-based global task ordinal (matches the platform record's taskIndex). */
  taskIndex: number;
  /** Current phase name, when the benchmark declares `phases`. */
  phase?: string;
  /**
   * Runs `fn` as a named platform step. Mirrors `@benchsdk/client`'s
   * `RunWorkerContext.step`; supports closures and try/finally.
   */
  step<R>(name: string, fn: () => Promise<R> | R, options?: DefineStepOptions): Promise<R>;
  /**
   * Attaches a JSON measurement to the platform. Inside a `step` it lands on
   * that step's data; at task top-level it lands on the task record's data.
   */
  measure(data: JsonObject): void;
  /** Appends a line to the worker log, uploaded as an artifact when the worker finishes. */
  log(message: string, meta?: JsonObject): void;
}

export type BenchmarkTask<T extends BaseParticipant = BaseParticipant> = (
  ctx: TaskContext<T>,
) => Promise<TaskResult | void> | TaskResult | void;

/**
 * A named run segment with its own iteration count. Phases run in order; each
 * record is tagged with the phase name via `data.phase`, and `ctx.phase` lets
 * the task branch on identity instead of index arithmetic.
 */
export interface Phase {
  /** Phase name, tagged onto every record produced in this phase. */
  name: string;
  /** Iterations to run in this phase. */
  iterations: number;
}

/** One participant's collected task records from a run. */
export interface ParticipantRecords {
  participant: string;
  records: TaskResultRecord[];
}

/** The orchestration knobs a run actually used, after CLI overrides. */
export interface ResolvedRunConfig {
  iterations: number;
  concurrency: number;
  staggerDelayMs: number;
  groupBy: GroupBy;
  providers?: string[];
}

/**
 * Result of a benchmark run, passed to `config.onComplete`. Exposes the raw
 * per-participant records so completion hooks can write legacy local results.
 */
export interface BenchmarkRunOutcome {
  runId: string;
  dashboardUrl: string;
  participants: ParticipantRecords[];
  config: ResolvedRunConfig;
}

/**
 * Orchestration config for a benchmark. Holds identity, the knobs, the
 * participants, and the optional completion hook — the workload lives in a
 * separate `defineTask`. `bench run <file>` reads the `config` and `task`
 * exports from the module and drives the run.
 */
export interface BenchmarkConfig<T extends BaseParticipant = BaseParticipant> {
  /**
   * Stable platform slug for this benchmark (e.g. 'sandbox-tti-local').
   * Overridable per run with `--slug`, so one entrypoint can report under
   * several benchmarks.
   */
  benchmarkSlug: string;
  /** Human-readable name shown on the platform. Overridable with `--name`. */
  benchmarkName: string;
  /** Optional platform benchmark kind (e.g. 'sandbox'). */
  benchmarkKind?: string;
  /**
   * Total tasks to run per participant. Default: 1. Mutually exclusive with
   * `phases` — when `phases` is set, total iterations = sum of phase iterations.
   */
  iterations?: number;
  /**
   * Named run segments (e.g. cold/warm). Runs in order; each record is tagged
   * with the phase name via `data.phase`. Mutually exclusive with `iterations`.
   */
  phases?: Phase[];
  /** Max tasks in flight at once. 1 = sequential, N = burst. Default: 1. */
  concurrency?: number;
  /** Delay each task's start by `taskIndex * staggerDelayMs`. Default: 0. */
  staggerDelayMs?: number;
  /**
   * Task ordering across participants. Default: 'participant' (run each
   * participant's tasks to completion, then the next). 'round' takes turns:
   * every participant runs its Nth task before anyone runs their (N+1)th, so
   * all participants' Nth tasks happen back-to-back under the same conditions.
   */
  groupBy?: GroupBy;
  /**
   * Default participant names to run when `--provider` is not passed. Omit to
   * run all env-available participants. `--provider` always overrides this.
   */
  defaultProviders?: string[];
  /** The participants this benchmark can run against. `--provider` selects a subset by name. */
  participants: T[];
  /**
   * Run-level completion hook, called once with the full outcome after every
   * participant finishes. Use it for aggregate output (legacy JSON/SVG
   * writers). This is the run-level counterpart to per-step `ctx.measure`.
   */
  onComplete?: (outcome: BenchmarkRunOutcome) => void | Promise<void>;
}

function assertPositiveInt(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be an integer >= 1 (got ${value})`);
  }
}

/** Validates `config` at file-evaluation time so mistakes surface immediately. */
export function defineBenchmarkConfig<T extends BaseParticipant = BaseParticipant>(
  config: BenchmarkConfig<T>,
): BenchmarkConfig<T> {
  if (!config.benchmarkSlug || typeof config.benchmarkSlug !== 'string') {
    throw new Error('benchmarkSlug is required');
  }
  if (!config.benchmarkName || typeof config.benchmarkName !== 'string') {
    throw new Error('benchmarkName is required');
  }
  if (config.phases !== undefined) {
    if (config.iterations !== undefined) {
      throw new Error('phases and iterations are mutually exclusive');
    }
    if (!Array.isArray(config.phases) || config.phases.length === 0) {
      throw new Error('phases must be a non-empty array');
    }
    const seen = new Set<string>();
    for (const phase of config.phases) {
      if (!phase.name || typeof phase.name !== 'string') {
        throw new Error('each phase requires a non-empty name');
      }
      if (seen.has(phase.name)) {
        throw new Error(`duplicate phase name: ${phase.name}`);
      }
      seen.add(phase.name);
      assertPositiveInt(phase.iterations, `phase '${phase.name}' iterations`);
    }
  }
  assertPositiveInt(config.iterations, 'iterations');
  assertPositiveInt(config.concurrency, 'concurrency');
  if (config.staggerDelayMs !== undefined && (!Number.isFinite(config.staggerDelayMs) || config.staggerDelayMs < 0)) {
    throw new Error(`staggerDelayMs must be a number >= 0 (got ${config.staggerDelayMs})`);
  }
  if (config.groupBy !== undefined && config.groupBy !== 'participant' && config.groupBy !== 'round') {
    throw new Error(`groupBy must be 'participant' or 'round' (got ${config.groupBy})`);
  }
  return config;
}

/**
 * Declares the workload for a benchmark: a function invoked once per iteration.
 * Steps are named via `ctx.step`, which supports closures and try/finally so
 * values flow naturally between steps.
 *
 *   export const task = defineTask(async (ctx) => {
 *     const sandbox = await ctx.step('create', () => provider.create());
 *     try { await ctx.step('exec', () => sandbox.run('node -v')); }
 *     finally { await ctx.step('destroy', () => sandbox.destroy()); }
 *   });
 */
export function defineTask<T extends BaseParticipant = BaseParticipant>(
  task: BenchmarkTask<T>,
): BenchmarkTask<T> {
  if (typeof task !== 'function') {
    throw new Error('defineTask requires a task function.');
  }
  return task;
}
