import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createBenchmarkClient = vi.fn();
const reporterClaim = vi.fn();

vi.mock('@benchsdk/client', () => ({
  createBenchmarkClient: (...args: unknown[]) => createBenchmarkClient(...args),
  BenchmarkReporter: { claim: (...args: unknown[]) => reporterClaim(...args) },
  selectParticipants: (all: any[], names?: string[]) => (names ? all.filter((p) => names.includes(p.name)) : all),
  filterParticipantsByEnv: (ps: any[]) => {
    const available: any[] = [];
    const skipped: { name: string; missing: string[] }[] = [];
    for (const p of ps) {
      const missing = (p.requiredEnvVars as string[]).filter((v) => !process.env[v]);
      if (missing.length) skipped.push({ name: p.name, missing });
      else available.push(p);
    }
    return { available, skipped };
  },
}));

import { parseCliArgs, mergeConfig, runBenchmark } from '../runner';
import { TaskError } from '../bench-config';
import { NoAvailableParticipantsError } from '../no-available-participants';
import type { BenchmarkConfig } from '../bench-config';
import type { TaskResultRecord } from '@benchsdk/client';

describe('parseCliArgs', () => {
  it('parses space-separated flags', () => {
    expect(parseCliArgs(['--iterations', '10', '--concurrency', '4', '--stagger-delay-ms', '250'])).toEqual({
      iterations: 10,
      concurrency: 4,
      staggerDelayMs: 250,
    });
  });

  it('parses = separated flags', () => {
    expect(parseCliArgs(['--iterations=7', '--concurrency=2'])).toEqual({ iterations: 7, concurrency: 2 });
  });

  it('parses comma-separated and repeated --provider', () => {
    expect(parseCliArgs(['--provider', 'e2b,modal', '--provider', 'daytona'])).toEqual({
      providers: ['e2b', 'modal', 'daytona'],
    });
  });

  it('parses --group-by', () => {
    expect(parseCliArgs(['--group-by', 'round'])).toEqual({ groupBy: 'round' });
    expect(parseCliArgs(['--group-by=participant'])).toEqual({ groupBy: 'participant' });
  });

  it('throws on invalid --group-by', () => {
    expect(() => parseCliArgs(['--group-by', 'nope'])).toThrow('--group-by');
  });

  it('ignores unknown flags', () => {
    expect(parseCliArgs(['--unknown', 'x', '--iterations', '3'])).toEqual({ iterations: 3 });
  });

  it('throws on non-numeric numeric flags', () => {
    expect(() => parseCliArgs(['--iterations', 'abc'])).toThrow('--iterations');
  });

  it('throws on empty, negative, or non-integer iterations/concurrency', () => {
    expect(() => parseCliArgs(['--iterations', ''])).toThrow('--iterations');
    expect(() => parseCliArgs(['--iterations', '-3'])).toThrow('--iterations');
    expect(() => parseCliArgs(['--iterations', '1.5'])).toThrow('--iterations');
    expect(() => parseCliArgs(['--concurrency', '0'])).toThrow('--concurrency');
  });

  it('throws on negative stagger delay', () => {
    expect(() => parseCliArgs(['--stagger-delay-ms', '-1'])).toThrow('--stagger-delay-ms');
  });

  it('returns empty object for no args', () => {
    expect(parseCliArgs([])).toEqual({});
  });
});

describe('mergeConfig', () => {
  const config: BenchmarkConfig = {
    benchmarkSlug: 's',
    benchmarkName: 'n',
    iterations: 100,
    concurrency: 1,
    staggerDelayMs: 0,
    task: async () => ({}),
  };

  it('uses config defaults when no CLI args', () => {
    expect(mergeConfig(config, {})).toEqual({ iterations: 100, concurrency: 1, staggerDelayMs: 0, groupBy: 'participant', providers: undefined });
  });

  it('lets CLI args win over config', () => {
    expect(mergeConfig(config, { iterations: 5, concurrency: 5, staggerDelayMs: 200, groupBy: 'round', providers: ['e2b'] })).toEqual({
      iterations: 5,
      concurrency: 5,
      staggerDelayMs: 200,
      groupBy: 'round',
      providers: ['e2b'],
    });
  });

  it('falls back to knob defaults of 1/1/0/participant when neither config nor CLI set them', () => {
    const bare: BenchmarkConfig = { benchmarkSlug: 's', benchmarkName: 'n', task: async () => ({}) };
    expect(mergeConfig(bare, {})).toEqual({ iterations: 1, concurrency: 1, staggerDelayMs: 0, groupBy: 'participant', providers: undefined });
  });

  it('uses config.groupBy when CLI does not set it', () => {
    const rr: BenchmarkConfig = { benchmarkSlug: 's', benchmarkName: 'n', groupBy: 'round', task: async () => ({}) };
    expect(mergeConfig(rr, {}).groupBy).toBe('round');
  });

  it('falls back to config.defaultProviders when --provider is not passed', () => {
    const withDefaults: BenchmarkConfig = { benchmarkSlug: 's', benchmarkName: 'n', defaultProviders: ['e2b'], task: async () => ({}) };
    expect(mergeConfig(withDefaults, {}).providers).toEqual(['e2b']);
    expect(mergeConfig(withDefaults, { providers: ['modal'] }).providers).toEqual(['modal']);
  });

  it('derives iterations from phases (sum) and ignores --iterations with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const phased: BenchmarkConfig = {
      benchmarkSlug: 's',
      benchmarkName: 'n',
      phases: [{ name: 'cold', iterations: 3 }, { name: 'warm', iterations: 2 }],
      task: async () => ({}),
    };
    expect(mergeConfig(phased, {}).iterations).toBe(5);
    expect(mergeConfig(phased, { iterations: 99 }).iterations).toBe(5);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('runBenchmark', () => {
  const participants = [
    { name: 'e2b', requiredEnvVars: ['E2B_API_KEY'] },
    { name: 'modal', requiredEnvVars: ['MODAL_TOKEN'] },
  ];

  let calls: Record<string, any[]>;
  let fakeClient: any;
  let taskRangeStart: number;

  beforeEach(() => {
    taskRangeStart = 0;
    vi.restoreAllMocks();
    reporterClaim.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.E2B_API_KEY = 'x';
    process.env.MODAL_TOKEN = 'y';
    calls = { upsertBenchmark: [], createRun: [], planWorkers: [], runWorker: [], taskData: [] };
    fakeClient = {
      upsertBenchmark: vi.fn(async (...a: any[]) => { calls.upsertBenchmark.push(a); return {}; }),
      createRun: vi.fn(async (...a: any[]) => { calls.createRun.push(a); return { run: { id: 'run-1' }, participants: [] }; }),
      planWorkers: vi.fn(async (...a: any[]) => { calls.planWorkers.push(a); return []; }),
      runWorker: vi.fn(async (opts: any) => {
        calls.runWorker.push(opts);
        const total = calls.createRun[0]?.[1]?.totalTasks ?? 1;
        // The platform hands out globally-indexed task ranges; `taskRangeStart`
        // lets a test exercise a worker whose range doesn't start at 0.
        const start = taskRangeStart;
        const assignment = { workerId: 'w1', taskRange: { start, end: start + total - 1, count: total } };
        const records: any[] = [];
        for (let ti = start; ti < start + total; ti++) {
          const data = await opts.task({ taskIndex: ti, assignment, step: async (_n: string, fn: any) => fn() });
          calls.taskData.push(data);
          const rec = { taskIndex: ti, status: 'success', data: data ?? {} };
          opts.onResult?.(rec);
          records.push(rec);
        }
        return { assignment, records };
      }),
    };
    createBenchmarkClient.mockReturnValue(fakeClient);
  });

  afterEach(() => {
    delete process.env.E2B_API_KEY;
    delete process.env.MODAL_TOKEN;
  });

  it('drives upsert -> createRun -> planWorkers/runWorker per available participant', async () => {
    const task = vi.fn(async () => ({ data: { ttiMs: 42 } }));
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 'sandbox-tti-local',
      benchmarkName: 'Sandbox TTI',
      benchmarkKind: 'sandbox',
      iterations: 3,
      concurrency: 1,
      task,
    };

    const outcome = await runBenchmark(config, participants, []);

    expect(outcome.runId).toBe('run-1');
    expect(outcome.participants.map((p) => p.participant)).toEqual(['e2b', 'modal']);
    expect(outcome.participants[0].records).toHaveLength(3);
    expect(outcome.participants[1].records).toHaveLength(3);

    expect(calls.upsertBenchmark[0][0]).toBe('sandbox-tti-local');
    expect(calls.upsertBenchmark[0][1]).toMatchObject({ name: 'Sandbox TTI', kind: 'sandbox' });
    expect(calls.createRun[0][1]).toMatchObject({ totalTasks: 3, workerCount: 1, participants: ['e2b', 'modal'] });
    expect(calls.planWorkers).toHaveLength(2);
    expect(calls.runWorker).toHaveLength(2);
    expect(calls.runWorker[0].concurrency).toBe(1);
    // The runner's task wrapper forwards participant/taskIndex/phase/step to config.task.
    expect(task).toHaveBeenCalledWith(expect.objectContaining({ participant: participants[0], taskIndex: 0 }));
    // Uniform TaskResult: the wrapper returns the task's `data` payload to the platform worker.
    expect(calls.taskData[0]).toEqual({ ttiMs: 42 });
  });

  it('applies CLI overrides over config', async () => {
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 's',
      benchmarkName: 'n',
      iterations: 100,
      concurrency: 1,
      task: async () => ({}),
    };

    await runBenchmark(config, participants, ['--iterations', '5', '--concurrency', '5', '--provider', 'e2b']);

    expect(calls.createRun[0][1]).toMatchObject({ totalTasks: 5, participants: ['e2b'] });
    expect(calls.runWorker).toHaveLength(1);
    expect(calls.runWorker[0].concurrency).toBe(5);
  });

  it('throws NoAvailableParticipantsError, listing the skips, when no participant has its env vars set', async () => {
    delete process.env.E2B_API_KEY;
    delete process.env.MODAL_TOKEN;

    const err = await runBenchmark(
      { benchmarkSlug: 's', benchmarkName: 'n', task: async () => ({}) },
      participants,
      [],
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoAvailableParticipantsError);
    expect((err as NoAvailableParticipantsError).skipped).toEqual([
      { name: 'e2b', missing: ['E2B_API_KEY'] },
      { name: 'modal', missing: ['MODAL_TOKEN'] },
    ]);
    expect(createBenchmarkClient).not.toHaveBeenCalled();
  });

  it('participant mode: tags data.phase from the schedule', async () => {
    const seenPhases: (string | undefined)[] = [];
    const task = vi.fn(async (ctx: any) => {
      seenPhases.push(ctx.phase);
      return { data: { i: ctx.taskIndex } };
    });

    await runBenchmark(
      {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        phases: [{ name: 'cold', iterations: 2 }, { name: 'warm', iterations: 1 }],
        task,
      },
      [participants[0]],
      [],
    );

    expect(calls.createRun[0][1].totalTasks).toBe(3);
    expect(seenPhases).toEqual(['cold', 'cold', 'warm']);
    expect(calls.taskData).toEqual([
      { i: 0, phase: 'cold' },
      { i: 1, phase: 'cold' },
      { i: 2, phase: 'warm' },
    ]);
  });

  it('groupBy round: claims one reporter per participant, interleaves rounds, finishes each', async () => {
    const recorded: Record<string, TaskResultRecord[]> = { e2b: [], modal: [] };
    const finished: Record<string, boolean> = {};
    reporterClaim.mockImplementation(async (cfg: any) => ({
      taskIndexStart: 0,
      recordResult: (r: TaskResultRecord) => recorded[cfg.participantSlug].push(r),
      uploadArtifact: async () => ({}),
      setProgress: () => {},
      heartbeat: async () => {},
      finish: async (failedFlag: boolean) => { finished[cfg.participantSlug] = failedFlag; },
    }));

    // Task returns a pre-measured step + data; records interleave e2b,modal per round.
    const order: string[] = [];
    const task = vi.fn(async (ctx: any) => {
      order.push(`${ctx.participant.name}#${ctx.taskIndex}`);
      return { data: { ok: true }, steps: [{ name: 'probe', status: 'success' as const, latencyMs: 5 }] };
    });

    const outcome = await runBenchmark(
      { benchmarkSlug: 'ai-gateway-local', benchmarkName: 'AI GW', iterations: 2, groupBy: 'round', task },
      participants,
      [],
    );

    expect(outcome.participants.map((p) => p.participant)).toEqual(['e2b', 'modal']);
    expect(outcome.participants[0].records).toHaveLength(2);
    expect(outcome.participants[1].records).toHaveLength(2);
    expect(outcome.participants[0].records).toEqual(recorded.e2b);
    expect(outcome.participants[1].records).toEqual(recorded.modal);

    expect(reporterClaim).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['e2b#0', 'modal#0', 'e2b#1', 'modal#1']);
    expect(recorded.e2b).toHaveLength(2);
    expect(recorded.modal).toHaveLength(2);
    // Task-owned steps are persisted onto the built record in round mode.
    expect(recorded.e2b[0].steps).toEqual([{ name: 'probe', status: 'success', latencyMs: 5 }]);
    expect(recorded.e2b[0].status).toBe('success');
    expect(finished.e2b).toBe(false);
    expect(finished.modal).toBe(false);
    // runWorker is NOT used in round mode; the single worker per participant is
    // planned for every task in the schedule, not just one.
    expect(fakeClient.runWorker).not.toHaveBeenCalled();
    expect(fakeClient.planWorkers).toHaveBeenCalledTimes(2);
    expect(calls.planWorkers[0][3]).toMatchObject({ workerCount: 1, targetConcurrency: 2 });
  });

  it('groupBy round with phases: tags each record with its phase in order', async () => {
    const recorded: Record<string, TaskResultRecord[]> = { e2b: [] };
    reporterClaim.mockImplementation(async (cfg: any) => ({
      taskIndexStart: 0,
      recordResult: (r: TaskResultRecord) => recorded[cfg.participantSlug].push(r),
      uploadArtifact: async () => ({}),
      setProgress: () => {},
      heartbeat: async () => {},
      finish: async () => {},
    }));

    const task = vi.fn(async (ctx: any) => ({ data: { phaseSeen: ctx.phase }, latencyMs: 11 }));

    await runBenchmark(
      {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        phases: [{ name: 'cold', iterations: 2 }, { name: 'warm', iterations: 1 }],
        groupBy: 'round',
        task,
      },
      [participants[0]],
      [],
    );

    expect(calls.createRun[0][1].totalTasks).toBe(3);
    expect(recorded.e2b.map((r) => r.data?.phase)).toEqual(['cold', 'cold', 'warm']);
    // Task-owned latency overrides framework wall-clock.
    expect(recorded.e2b.every((r) => r.latencyMs === 11)).toBe(true);
  });

  it('groupBy round: reports worker progress after every record', async () => {
    const progress: Array<{ done: number; inFlight: number; errors: number; total?: number }> = [];
    let heartbeats = 0;
    reporterClaim.mockImplementation(async () => ({
      taskIndexStart: 0,
      recordResult: () => {},
      uploadArtifact: async () => ({}),
      setProgress: (p: { done: number; inFlight: number; errors: number; total?: number }) => progress.push(p),
      heartbeat: async () => { heartbeats += 1; },
      finish: async () => {},
    }));

    let attempt = 0;
    const task = vi.fn(async () => {
      attempt += 1;
      if (attempt === 2) throw new TaskError('boom', { code: 'probe_failed' });
      return {};
    });

    await runBenchmark(
      { benchmarkSlug: 's', benchmarkName: 'n', iterations: 3, groupBy: 'round', task },
      [participants[0]],
      [],
    );

    expect(progress).toEqual([
      { done: 1, inFlight: 0, errors: 0, total: 3 },
      { done: 2, inFlight: 0, errors: 1, total: 3 },
      { done: 3, inFlight: 0, errors: 1, total: 3 },
    ]);
    expect(heartbeats).toBe(3);
  });

  it('participant mode: schedule + ctx.taskIndex are relative to the worker task range start', async () => {
    taskRangeStart = 10;
    const seen: { phase?: string; taskIndex: number }[] = [];
    const task = vi.fn(async (ctx: any) => {
      seen.push({ phase: ctx.phase, taskIndex: ctx.taskIndex });
      return {};
    });

    await runBenchmark(
      {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        phases: [{ name: 'cold', iterations: 2 }, { name: 'warm', iterations: 1 }],
        task,
      },
      [participants[0]],
      [],
    );

    expect(seen).toEqual([
      { phase: 'cold', taskIndex: 0 },
      { phase: 'cold', taskIndex: 1 },
      { phase: 'warm', taskIndex: 2 },
    ]);
  });

  it('participant mode: the ramp is anchored to the worker start, not accumulated per task', async () => {
    // The fake worker runs tasks one at a time, so every task is already past
    // its scheduled launch time — none of them should sleep.
    const starts: number[] = [];
    const t0 = Date.now();
    const task = vi.fn(async () => {
      starts.push(Date.now() - t0);
      await new Promise((r) => setTimeout(r, 40));
      return {};
    });

    await runBenchmark(
      { benchmarkSlug: 's', benchmarkName: 'n', iterations: 3, staggerDelayMs: 50, task },
      [participants[0]],
      [],
    );

    expect(starts).toHaveLength(3);
    // Accumulating index * 50ms on top of the 40ms of work would push the last
    // start past 140ms; anchored to the worker start it lands around 80ms.
    expect(starts[2]).toBeLessThan(130);
  });

  it('groupBy round: schedule index stays 0-based while records use the reporter offset', async () => {
    const recorded: TaskResultRecord[] = [];
    reporterClaim.mockImplementation(async () => ({
      taskIndexStart: 10,
      recordResult: (r: TaskResultRecord) => recorded.push(r),
      uploadArtifact: async () => ({}),
      setProgress: () => {},
      heartbeat: async () => {},
      finish: async () => {},
    }));

    const seen: { phase?: string; taskIndex: number }[] = [];
    const task = vi.fn(async (ctx: any) => {
      seen.push({ phase: ctx.phase, taskIndex: ctx.taskIndex });
      return {};
    });

    await runBenchmark(
      {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        phases: [{ name: 'cold', iterations: 2 }, { name: 'warm', iterations: 1 }],
        groupBy: 'round',
        task,
      },
      [participants[0]],
      [],
    );

    expect(seen).toEqual([
      { phase: 'cold', taskIndex: 0 },
      { phase: 'cold', taskIndex: 1 },
      { phase: 'warm', taskIndex: 2 },
    ]);
    expect(recorded.map((r) => r.taskIndex)).toEqual([10, 11, 12]);
    expect(recorded.map((r) => r.data?.phase)).toEqual(['cold', 'cold', 'warm']);
  });

  it('groupBy round: a TaskError is recorded with its code + data preserved and marks the reporter failed', async () => {
    const recorded: Record<string, TaskResultRecord[]> = { e2b: [] };
    const finished: Record<string, boolean> = {};
    reporterClaim.mockImplementation(async (cfg: any) => ({
      taskIndexStart: 0,
      recordResult: (r: TaskResultRecord) => recorded[cfg.participantSlug].push(r),
      uploadArtifact: async () => ({}),
      setProgress: () => {},
      heartbeat: async () => {},
      finish: async (failedFlag: boolean) => { finished[cfg.participantSlug] = failedFlag; },
    }));

    const task = async () => {
      throw new TaskError('boom', { code: 'probe_failed', data: { mode: 'cold' } });
    };

    await runBenchmark(
      { benchmarkSlug: 's', benchmarkName: 'n', iterations: 1, groupBy: 'round', task },
      [participants[0]],
      [],
    );

    expect(finished.e2b).toBe(true);
    expect(recorded.e2b[0].status).toBe('error');
    expect(recorded.e2b[0].errorCode).toBe('probe_failed');
    expect(recorded.e2b[0].data).toEqual({ mode: 'cold' });
  });
});
