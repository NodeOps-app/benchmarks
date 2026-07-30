import { describe, expect, it } from 'vitest';
import { defineBenchmark, TaskError } from '../bench-config';

const baseTask = async () => ({});

describe('defineBenchmark', () => {
  it('returns the config unchanged when valid', () => {
    const config = defineBenchmark({
      benchmarkSlug: 'sandbox-tti-local',
      benchmarkName: 'Sandbox TTI',
      benchmarkKind: 'sandbox',
      iterations: 5,
      concurrency: 1,
      staggerDelayMs: 0,
      task: baseTask,
    });
    expect(config.benchmarkSlug).toBe('sandbox-tti-local');
    expect(config.iterations).toBe(5);
  });

  it('allows the minimal shape (slug + name + task)', () => {
    const config = defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', task: baseTask });
    expect(config.iterations).toBeUndefined();
  });

  it('requires benchmarkSlug', () => {
    expect(() => defineBenchmark({ benchmarkSlug: '', benchmarkName: 'n', task: baseTask })).toThrow('benchmarkSlug is required');
  });

  it('requires benchmarkName', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: '', task: baseTask })).toThrow('benchmarkName is required');
  });

  it('requires task to be a function', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', task: undefined as any })).toThrow('task must be a function');
  });

  it('rejects non-integer or < 1 iterations', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', iterations: 0, task: baseTask })).toThrow('iterations');
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', iterations: 1.5, task: baseTask })).toThrow('iterations');
  });

  it('rejects concurrency < 1', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', concurrency: 0, task: baseTask })).toThrow('concurrency');
  });

  it('rejects negative staggerDelayMs', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', staggerDelayMs: -1, task: baseTask })).toThrow('staggerDelayMs');
  });

  it('accepts staggerDelayMs of 0', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', staggerDelayMs: 0, task: baseTask })).not.toThrow();
  });

  it('accepts a valid phases array', () => {
    const config = defineBenchmark({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      phases: [{ name: 'cold', iterations: 3 }, { name: 'warm', iterations: 3 }],
      task: baseTask,
    });
    expect(config.phases).toHaveLength(2);
  });

  it('rejects phases and iterations together', () => {
    expect(() =>
      defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', iterations: 2, phases: [{ name: 'cold', iterations: 1 }], task: baseTask }),
    ).toThrow('mutually exclusive');
  });

  it('rejects an empty phases array', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', phases: [], task: baseTask })).toThrow('non-empty');
  });

  it('rejects a phase with non-integer or < 1 iterations', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', phases: [{ name: 'cold', iterations: 0 }], task: baseTask })).toThrow('cold');
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', phases: [{ name: 'cold', iterations: 1.5 }], task: baseTask })).toThrow('cold');
  });

  it('rejects duplicate phase names', () => {
    expect(() =>
      defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', phases: [{ name: 'cold', iterations: 1 }, { name: 'cold', iterations: 1 }], task: baseTask }),
    ).toThrow('duplicate phase name');
  });

  it('rejects a phase task that is not a function', () => {
    expect(() =>
      defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', phases: [{ name: 'cold', iterations: 1, task: 'x' as any }], task: baseTask }),
    ).toThrow('must be a function');
  });
});

describe('TaskError', () => {
  it('carries code, data, and steps and names itself', () => {
    const err = new TaskError('boom', { code: 'probe_failed', data: { mode: 'cold' }, steps: [{ name: 'ttft', status: 'success', latencyMs: 5 }] });
    expect(err.name).toBe('TaskError');
    expect(err.message).toBe('boom');
    expect(err.code).toBe('probe_failed');
    expect(err.data).toEqual({ mode: 'cold' });
    expect(err.steps).toEqual([{ name: 'ttft', status: 'success', latencyMs: 5 }]);
    expect(err).toBeInstanceOf(Error);
  });

  it('allows construction without options', () => {
    const err = new TaskError('boom');
    expect(err.code).toBeUndefined();
    expect(err.data).toBeUndefined();
    expect(err.steps).toBeUndefined();
  });
});
