/**
 * `bench run <file> [--flags]` — the author-facing entrypoint. Imports a
 * benchmark module, reads its `config` and `task` exports, and drives the run
 * via the internal `runBenchmark`. CLI flags override the config's knobs, and
 * `config.onComplete` (if any) fires once the run finishes.
 *
 * The executable wrapper lives in `bin.ts`; this module has no side effects so
 * it can be unit-tested by calling `runBenchmarkFile` directly.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBenchmark } from './runner.js';
import { NoAvailableParticipantsError } from './no-available-participants.js';
import type { BaseParticipant } from '@benchsdk/client';
import type { BenchmarkConfig, BenchmarkTask } from './bench-config.js';

const USAGE =
  'Usage: bench run <file.bench.ts> [--iterations N] [--concurrency N] ' +
  '[--stagger-delay-ms N] [--group-by participant|round] [--provider a,b]';

/** A benchmark module is expected to export `config` and `task`. */
interface BenchmarkModule {
  config?: unknown;
  task?: unknown;
  default?: unknown;
}

function isBenchmarkConfig(value: unknown): value is BenchmarkConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { benchmarkSlug?: unknown; participants?: unknown };
  return typeof candidate.benchmarkSlug === 'string' && Array.isArray(candidate.participants);
}

/**
 * Loads a benchmark file and runs it. Throws on bad usage / invalid exports and
 * lets `NoAvailableParticipantsError` propagate so the caller can map it to a
 * clean exit. Does not call `process.exit`.
 */
export async function runBenchmarkFile(argv: string[]): Promise<void> {
  const [command, file, ...rest] = argv;
  if (command !== 'run' || !file) {
    throw new Error(USAGE);
  }

  const moduleUrl = pathToFileURL(resolve(process.cwd(), file)).href;
  const mod = (await import(moduleUrl)) as BenchmarkModule;

  const config = mod.config;
  const task = mod.task ?? mod.default;

  if (!isBenchmarkConfig(config)) {
    throw new Error(`${file} must export a \`config\` created with defineBenchmarkConfig (with participants).`);
  }
  if (typeof task !== 'function') {
    throw new Error(`${file} must export a \`task\` created with defineTask.`);
  }

  await runBenchmark(config as BenchmarkConfig<BaseParticipant>, task as BenchmarkTask<BaseParticipant>, rest);
}

/** Executable entry: runs the file and maps outcomes to process exit codes. */
export async function run(argv: string[]): Promise<void> {
  try {
    await runBenchmarkFile(argv);
    // Provider SDKs can leave sockets/timers open; exit explicitly so a
    // finished run doesn't hang.
    process.exit(0);
  } catch (err) {
    if (err instanceof NoAvailableParticipantsError) {
      console.log(err.message);
      process.exit(0);
    }
    console.error('Benchmark failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
