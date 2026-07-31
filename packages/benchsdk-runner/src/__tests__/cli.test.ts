import { describe, expect, it } from 'vitest';
import { runBenchmarkFile } from '../cli';
import { NoAvailableParticipantsError } from '../no-available-participants.js';

const fixture = (name: string) => `src/__tests__/fixtures/${name}`;

describe('runBenchmarkFile', () => {
  it('rejects when the command is not `run`', async () => {
    await expect(runBenchmarkFile([])).rejects.toThrow(/Usage: bench run/);
    await expect(runBenchmarkFile(['nope', fixture('good.bench.ts')])).rejects.toThrow(/Usage: bench run/);
  });

  it('rejects when no file is given', async () => {
    await expect(runBenchmarkFile(['run'])).rejects.toThrow(/Usage: bench run/);
  });

  it('rejects a module that does not export a config', async () => {
    await expect(runBenchmarkFile(['run', fixture('no-config.bench.ts')])).rejects.toThrow(/must export a `config`/);
  });

  it('rejects a module that does not export a task', async () => {
    await expect(runBenchmarkFile(['run', fixture('no-task.bench.ts')])).rejects.toThrow(/must export a `task`/);
  });

  it('imports a valid module and drives the run, surfacing NoAvailableParticipantsError', async () => {
    // The fixture's participant requires an env var that is never set, so the
    // run env-gates to zero participants before any network call. Extra CLI
    // flags after the file are forwarded to the runner without error.
    await expect(
      runBenchmarkFile(['run', fixture('good.bench.ts'), '--iterations', '3']),
    ).rejects.toBeInstanceOf(NoAvailableParticipantsError);
  });
});
