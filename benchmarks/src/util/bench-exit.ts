import { NoAvailableParticipantsError } from '@benchsdk/cli';

/**
 * Terminal handler for a bench script's `runBenchmark` promise. A run where
 * every participant was env-gated out is a skip, not a failure — the legacy
 * runner reported those providers as `skipped` and exited 0, and the benchmark
 * workflows run one job per provider whether or not its credentials exist.
 */
export function exitOnBenchmarkError(err: unknown): never {
  if (err instanceof NoAvailableParticipantsError) {
    console.log(err.message);
    process.exit(0);
  }
  console.error('Benchmark failed:', err);
  process.exit(1);
}
