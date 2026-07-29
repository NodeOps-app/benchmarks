/**
 * CLI runner for `defineBenchmark` configs. Owns all platform orchestration
 * (upsert benchmark, create run, plan + drive workers per participant) so a
 * `*.bench.ts` file only has to declare its config and task. The orchestration
 * knobs (iterations / concurrency / staggerDelayMs / groupBy) can be overridden
 * per-invocation via CLI flags.
 *
 * Two execution orderings, chosen by `groupBy`:
 *   'participant' (default) — each participant's tasks run to completion via
 *     `client.runWorker` (with its pooled concurrency + heartbeat reporting)
 *     before the next participant starts.
 *   'round' — participants take turns: every participant runs its Nth task
 *     before anyone starts their (N+1)th, so all Nth tasks happen back-to-back
 *     under the same conditions. Driven manually via one `BenchmarkReporter`
 *     per participant.
 */
import {
  BenchmarkReporter,
  createBenchmarkClient,
  filterParticipantsByEnv,
  selectParticipants,
} from '@benchsdk/client';
import { NoAvailableParticipantsError } from './no-available-participants.js';
import type {
  BaseParticipant,
  BenchmarkClient,
  BenchmarkRun,
  JsonObject,
  RunWorkerContext,
  TaskResultRecord,
  TaskStepRecord,
} from '@benchsdk/client';
import { TaskError } from './bench-config.js';
import type { BenchmarkConfig, BenchmarkTask, GroupBy, TaskContext, TaskResult } from './bench-config.js';
import { LogBuffer, uploadWorkerLog } from './log-buffer.js';
import { loggedStep } from './logged-step.js';

export interface CliArgs {
  iterations?: number;
  concurrency?: number;
  staggerDelayMs?: number;
  groupBy?: GroupBy;
  /** Participant names from `--provider a,b` (repeatable). */
  providers?: string[];
}

export interface ResolvedRunConfig {
  iterations: number;
  concurrency: number;
  staggerDelayMs: number;
  groupBy: GroupBy;
  providers?: string[];
}

/** One participant's collected task records from a run. */
export interface ParticipantRecords {
  participant: string;
  records: TaskResultRecord[];
}

/**
 * Result of a benchmark run. TEMPORARY BRIDGE: exposes the raw per-participant
 * records so callers can write legacy local JSON results, until the platform
 * read API can supply per-iteration data + `data` payloads directly.
 */
export interface BenchmarkRunOutcome {
  runId: string;
  dashboardUrl: string;
  participants: ParticipantRecords[];
  /** Knobs the run actually used, after CLI overrides. */
  config: ResolvedRunConfig;
}

// Matches @benchsdk/client's DEFAULT_BASE_URL origin. `resolvePlatform()`
// appends `/api/v1`. Override for local development via BENCHMARKS_PLATFORM_URL.
const DEFAULT_PLATFORM_URL = 'https://platform.computesdk.com';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'ERROR';
}

/**
 * Parses the orchestration flags this runner understands, ignoring anything
 * else. Supports both `--flag value` and `--flag=value`; `--provider` accepts
 * a comma-separated list and may be repeated.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  const readValue = (raw: string, i: number): { value: string; nextIndex: number } => {
    const eq = raw.indexOf('=');
    if (eq !== -1) return { value: raw.slice(eq + 1), nextIndex: i };
    return { value: argv[i + 1] ?? '', nextIndex: i + 1 };
  };

  const intFlag = (raw: string, flag: string): number => {
    if (raw.trim() === '') throw new Error(`${flag} expects a value`);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} expects an integer >= 1 (got "${raw}")`);
    return n;
  };

  const nonNegFlag = (raw: string, flag: string): number => {
    if (raw.trim() === '') throw new Error(`${flag} expects a value`);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} expects a number >= 0 (got "${raw}")`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    switch (name) {
      case '--iterations': {
        const { value, nextIndex } = readValue(arg, i);
        args.iterations = intFlag(value, '--iterations');
        i = nextIndex;
        break;
      }
      case '--concurrency': {
        const { value, nextIndex } = readValue(arg, i);
        args.concurrency = intFlag(value, '--concurrency');
        i = nextIndex;
        break;
      }
      case '--stagger-delay-ms': {
        const { value, nextIndex } = readValue(arg, i);
        args.staggerDelayMs = nonNegFlag(value, '--stagger-delay-ms');
        i = nextIndex;
        break;
      }
      case '--group-by': {
        const { value, nextIndex } = readValue(arg, i);
        if (value !== 'participant' && value !== 'round') {
          throw new Error(`--group-by expects 'participant' or 'round' (got "${value}")`);
        }
        args.groupBy = value;
        i = nextIndex;
        break;
      }
      case '--provider': {
        const { value, nextIndex } = readValue(arg, i);
        const names = value.split(',').map((s) => s.trim()).filter(Boolean);
        args.providers = [...(args.providers ?? []), ...names];
        i = nextIndex;
        break;
      }
      default:
        break;
    }
  }

  return args;
}

/** Merges CLI overrides over config defaults, filling in knob fallbacks. */
export function mergeConfig<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  args: CliArgs,
): ResolvedRunConfig {
  const phaseTotal = config.phases?.reduce((sum, p) => sum + p.iterations, 0);
  if (phaseTotal !== undefined && args.iterations !== undefined) {
    console.warn('--iterations is ignored because this benchmark declares phases.');
  }
  const resolved: ResolvedRunConfig = {
    iterations: phaseTotal ?? args.iterations ?? config.iterations ?? 1,
    concurrency: args.concurrency ?? config.concurrency ?? 1,
    staggerDelayMs: args.staggerDelayMs ?? config.staggerDelayMs ?? 0,
    groupBy: args.groupBy ?? config.groupBy ?? 'participant',
    providers: args.providers ?? config.defaultProviders,
  };
  if (!Number.isInteger(resolved.iterations) || resolved.iterations < 1) {
    throw new Error(`iterations must be an integer >= 1 (got ${resolved.iterations})`);
  }
  if (!Number.isInteger(resolved.concurrency) || resolved.concurrency < 1) {
    throw new Error(`concurrency must be an integer >= 1 (got ${resolved.concurrency})`);
  }
  return resolved;
}

/** One scheduled task slot: which task to run and (optionally) under which phase. */
interface Slot<T extends BaseParticipant = BaseParticipant> {
  phase?: string;
  task: BenchmarkTask<T>;
}

/**
 * Flattens a config into an ordered list of task slots. With `phases`, each
 * phase contributes `iterations` slots tagged with its name (framework owns
 * the phase boundary — no index arithmetic in the task). Without phases, the
 * top-level task is repeated `iterations` times.
 */
function buildSchedule<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  iterations: number,
): Slot<T>[] {
  if (config.phases?.length) {
    return config.phases.flatMap((phase) =>
      Array.from({ length: phase.iterations }, () => ({ phase: phase.name, task: phase.task ?? config.task })),
    );
  }
  return Array.from({ length: iterations }, () => ({ phase: undefined, task: config.task }));
}

type OnResult = (record: TaskResultRecord, meta: { iterations: number }) => void;

function defaultOnResult(record: TaskResultRecord, meta: { iterations: number }): void {
  const n = record.taskIndex + 1;
  if (record.status === 'success') {
    const data = record.data && Object.keys(record.data).length > 0 ? ` ${JSON.stringify(record.data)}` : '';
    console.log(`  Task ${n}/${meta.iterations}: success${data}`);
  } else {
    console.log(`  Task ${n}/${meta.iterations}: FAILED — ${record.errorCode ?? 'unknown error'}`);
  }
}

function resolvePlatform(): { baseUrl: string; orgSlug: string } {
  const root = (process.env.BENCHMARKS_PLATFORM_URL || DEFAULT_PLATFORM_URL).replace(/\/+$/, '');
  return {
    baseUrl: `${root}/api/v1`,
    orgSlug: process.env.BENCHMARKS_PLATFORM_ORG_SLUG || 'computesdk',
  };
}

/**
 * Runs `config` against `participants`. Selects participants by `--provider`
 * (if given), env-gates them, then drives them per the resolved `groupBy`.
 */
export async function runBenchmark<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  participants: T[],
  argv: string[] = [],
): Promise<BenchmarkRunOutcome> {
  const resolved = mergeConfig(config, parseCliArgs(argv));
  const schedule = buildSchedule(config, resolved.iterations);
  const totalTasks = schedule.length;

  const selected = selectParticipants(participants, resolved.providers);
  const { available, skipped } = filterParticipantsByEnv(selected);

  for (const s of skipped) {
    console.log(`Skipping ${s.name}: missing ${s.missing.join(', ')}`);
  }

  if (available.length === 0) {
    throw new NoAvailableParticipantsError(skipped);
  }

  const { baseUrl, orgSlug } = resolvePlatform();
  const client = createBenchmarkClient({ baseUrl });

  const concurrencyLabel = resolved.groupBy === 'round' ? 'n/a (round mode)' : String(resolved.concurrency);
  console.log(`${config.benchmarkName} (self-contained)`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(
    `Knobs: iterations=${totalTasks}, concurrency=${concurrencyLabel}, ` +
      `staggerDelayMs=${resolved.staggerDelayMs}, groupBy=${resolved.groupBy}\n`,
  );

  await client.upsertBenchmark(config.benchmarkSlug, {
    name: config.benchmarkName,
    ...(config.benchmarkKind ? { kind: config.benchmarkKind } : {}),
  });

  const { run } = await client.createRun(config.benchmarkSlug, {
    name: `${config.benchmarkSlug} — ${totalTasks} iterations, concurrency ${resolved.concurrency}`,
    totalTasks,
    workerCount: 1,
    participants: available.map((p) => p.name),
  });

  const dashboardUrl = `${baseUrl.replace(/\/api\/v1\/?$/, '')}/${orgSlug}/benchmarks/${config.benchmarkSlug}/runs/${run.id}`;
  console.log(`Run created: ${run.id}`);
  console.log(`View at: ${dashboardUrl}\n`);

  const onResult = config.onResult ?? defaultOnResult;

  let participantRecords: ParticipantRecords[];
  if (resolved.groupBy === 'round') {
    participantRecords = await runGroupedByRound(config, schedule, available, resolved, client, run, baseUrl, onResult);
  } else {
    participantRecords = await runGroupedByParticipant(config, schedule, available, resolved, client, run, onResult);
  }

  console.log(`All done. View at: ${dashboardUrl}`);
  return { runId: run.id, dashboardUrl, participants: participantRecords, config: resolved };
}

/**
 * 'participant' ordering: one `client.runWorker` per participant, in turn.
 * `staggerDelayMs` here launches task N at `workerStart + N * staggerDelayMs`
 * (vs. round mode's fixed delay between rounds — intentionally different).
 * `TaskResult.steps`/`latencyMs` are ignored in this path: the platform
 * worker owns step timing and latency.
 */
async function runGroupedByParticipant<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  schedule: Slot<T>[],
  available: T[],
  resolved: ResolvedRunConfig,
  client: BenchmarkClient,
  run: BenchmarkRun,
  onResult: OnResult,
): Promise<ParticipantRecords[]> {
  const participantRecords: ParticipantRecords[] = [];
  for (const participant of available) {
    console.log(`${'='.repeat(70)}`);
    console.log(`  Participant: ${participant.name}`);
    console.log('='.repeat(70));

    const logBuffer = new LogBuffer();
    // Anchors the ramp to the worker's start, so a pool narrower than the task
    // count can't inflate launch offsets: a task whose slot frees after its
    // scheduled launch time starts immediately instead of sleeping index*delay.
    let rampStartMs: number | undefined;
    await client.planWorkers(config.benchmarkSlug, run.id, participant.name);

    const result = await client.runWorker({
      benchmarkSlug: config.benchmarkSlug,
      runId: run.id,
      participantSlug: participant.name,
      concurrency: resolved.concurrency,
      task: async (ctx: RunWorkerContext) => {
        // `ctx.taskIndex` is the platform's global index; the schedule is
        // indexed from the worker's own task range start.
        const scheduleIndex = ctx.taskIndex - ctx.assignment.taskRange.start;
        if (resolved.staggerDelayMs > 0) {
          rampStartMs ??= Date.now();
          const waitMs = rampStartMs + scheduleIndex * resolved.staggerDelayMs - Date.now();
          if (waitMs > 0) await sleep(waitMs);
        }
        const slot = schedule[scheduleIndex];
        const taskResult = await slot.task({
          participant,
          taskIndex: scheduleIndex,
          phase: slot.phase,
          step: (name, fn, options) => loggedStep(ctx, logBuffer, name, fn, options),
        });
        const data = taskResult?.data;
        return slot.phase ? { ...(data ?? {}), phase: slot.phase } : data;
      },
      onResult: (record) => onResult(record, { iterations: schedule.length }),
      onFinish: (ctx) => uploadWorkerLog(ctx, logBuffer, participant.name),
    });

    if (!result.assignment) {
      console.error(`  No pending worker to claim for run ${run.id} — it may already be fully claimed.`);
      participantRecords.push({ participant: participant.name, records: result.records ?? [] });
      continue;
    }

    const ok = result.records.filter((r) => r.status === 'success').length;
    console.log(`  Done: ${ok}/${result.records.length} succeeded.\n`);
    participantRecords.push({ participant: participant.name, records: result.records });
  }

  return participantRecords;
}

/**
 * 'round' ordering: claim one `BenchmarkReporter` per participant up front,
 * then loop rounds, running one task per participant per round and streaming
 * each result to its reporter. Steps are built manually (no `client.runWorker`
 * to own them) via a shim that mirrors the platform's record shape.
 */
async function runGroupedByRound<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  schedule: Slot<T>[],
  available: T[],
  resolved: ResolvedRunConfig,
  client: BenchmarkClient,
  run: BenchmarkRun,
  baseUrl: string,
  onResult: OnResult,
): Promise<ParticipantRecords[]> {
  const reporters = new Map<string, BenchmarkReporter | null>();
  const logBuffers = new Map<string, LogBuffer>();
  const failed = new Map<string, boolean>();
  const recordsByParticipant = new Map<string, TaskResultRecord[]>();

  for (const participant of available) {
    logBuffers.set(participant.name, new LogBuffer());
    failed.set(participant.name, false);
    // One worker per participant drives every round sequentially. The platform
    // reads `targetConcurrency` as tasks-per-worker, so it must be the full
    // schedule length — otherwise only one task is planned and every record
    // past the first falls outside the worker's task range.
    await client.planWorkers(config.benchmarkSlug, run.id, participant.name, {
      workerCount: 1,
      targetConcurrency: schedule.length,
    });
    let reporter: BenchmarkReporter | null = null;
    try {
      reporter = await BenchmarkReporter.claim({
        baseUrl,
        benchmarkSlug: config.benchmarkSlug,
        runId: run.id,
        participantSlug: participant.name,
        processKind: 'process',
        processKey: process.env.HOSTNAME ?? 'local',
      });
    } catch (error) {
      console.warn(`  ${participant.name}: reporter claim failed (${error instanceof Error ? error.message : String(error)}) — running without platform reporting.`);
    }
    if (!reporter) {
      console.warn(`  ${participant.name}: could not claim a platform worker — running without platform reporting.`);
    }
    reporters.set(participant.name, reporter);
  }

  console.log(`Interleaving ${available.length} participant(s), ${schedule.length} round(s) each.\n`);

  for (let i = 0; i < schedule.length; i++) {
    const slot = schedule[i];
    // Round mode staggers a fixed delay between rounds (vs. participant mode's per-task stagger).
    if (resolved.staggerDelayMs > 0 && i > 0) {
      await sleep(resolved.staggerDelayMs);
    }
    for (const participant of available) {
      const reporter = reporters.get(participant.name) ?? null;
      const logBuffer = logBuffers.get(participant.name)!;
      const record = await runTaskRecord(
        slot.task,
        participant,
        i,
        (reporter?.taskIndexStart ?? 0) + i,
        slot.phase,
        logBuffer,
      );
      if (record.status !== 'success') failed.set(participant.name, true);
      onResult(record, { iterations: schedule.length });
      reporter?.recordResult(record);
      if (!recordsByParticipant.has(participant.name)) {
        recordsByParticipant.set(participant.name, []);
      }
      const participantRecords = recordsByParticipant.get(participant.name)!;
      participantRecords.push(record);
      // Round mode drives the worker by hand, so nothing reports progress
      // unless we do: without this the platform shows 0 done for the whole run.
      if (reporter) {
        reporter.setProgress({
          done: participantRecords.length,
          inFlight: 0,
          errors: participantRecords.filter((item) => item.status !== 'success').length,
          total: schedule.length,
        });
        await reporter.heartbeat();
      }
    }
  }

  for (const participant of available) {
    const reporter = reporters.get(participant.name) ?? null;
    const logBuffer = logBuffers.get(participant.name)!;
    if (reporter && !logBuffer.isEmpty()) {
      await reporter
        .uploadArtifact({ kind: 'coordinator.log', contentType: 'text/plain', name: 'worker.log', body: logBuffer.toText() })
        .catch(() => {});
    }
    await reporter?.finish(failed.get(participant.name) ?? false);
    console.log(`  ${participant.name}: done${failed.get(participant.name) ? ' (with errors)' : ''}.`);
  }

  return available.map((p) => ({ participant: p.name, records: recordsByParticipant.get(p.name) ?? [] }));
}

/** Merges a task's data payload with the current phase tag (if any). */
function mergeData(data: JsonObject | undefined, phase: string | undefined): JsonObject | undefined {
  if (!data && !phase) return undefined;
  return { ...(data ?? {}), ...(phase ? { phase } : {}) };
}

/**
 * Runs one task for the manual 'round' path, building its `TaskResultRecord`.
 * Honors the full `TaskResult` (task-owned data/steps/latency) and `TaskError`
 * (preserves domain data + steps on failure). Framework-timed `ctx.step` calls
 * and task-owned `result.steps` are both recorded.
 */
async function runTaskRecord<T extends BaseParticipant>(
  task: BenchmarkTask<T>,
  participant: T,
  scheduleIndex: number,
  taskIndex: number,
  phase: string | undefined,
  logBuffer: LogBuffer,
): Promise<TaskResultRecord> {
  const startedAtMs = Date.now();
  const record: TaskResultRecord = {
    taskIndex,
    status: 'success',
    startedAt: new Date(startedAtMs).toISOString(),
  };
  const frameworkSteps: TaskStepRecord[] = [];

  const ctx: TaskContext<T> = {
    participant,
    taskIndex: scheduleIndex,
    phase,
    async step(name, fn) {
      const stepStartedAtMs = Date.now();
      const stepRecord: TaskStepRecord = {
        name,
        status: 'success',
        startedAt: new Date(stepStartedAtMs).toISOString(),
        completedAt: new Date(stepStartedAtMs).toISOString(),
        latencyMs: 0,
      };
      try {
        const result = await fn();
        logBuffer.step(taskIndex, name, {});
        return result;
      } catch (error) {
        stepRecord.status = 'error';
        stepRecord.errorCode = getErrorCode(error);
        logBuffer.step(taskIndex, name, { error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        stepRecord.completedAt = new Date().toISOString();
        stepRecord.latencyMs = Date.now() - stepStartedAtMs;
        frameworkSteps.push(stepRecord);
      }
    },
  };

  let result: TaskResult | void = undefined;
  try {
    result = await task(ctx);
    record.data = mergeData(result?.data, phase);
  } catch (error) {
    record.status = 'error';
    if (error instanceof TaskError) {
      record.errorCode = error.code ?? error.name;
      record.data = mergeData(error.data, phase);
      if (error.steps?.length) frameworkSteps.push(...error.steps);
    } else {
      record.errorCode = getErrorCode(error);
      record.data = mergeData({ errorMessage: error instanceof Error ? error.message : String(error) }, phase);
    }
  } finally {
    const endMs = Date.now();
    record.completedAt = new Date(endMs).toISOString();
    record.latencyMs =
      record.status === 'success' && result && typeof result.latencyMs === 'number'
        ? result.latencyMs
        : endMs - startedAtMs;
    const taskSteps = record.status === 'success' && result?.steps ? result.steps : [];
    const allSteps = [...frameworkSteps, ...taskSteps];
    record.steps = allSteps.length > 0 ? allSteps : undefined;
  }

  return record;
}
