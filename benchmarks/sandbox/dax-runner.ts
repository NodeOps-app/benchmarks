import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { summarize } from './dax.js';
import type { DaxTimingResult } from './dax.js';
import type { ProviderConfig } from './types.js';
import { getSandboxOptionsWithResources, runDaxBuild } from './dax-workload.js';

/** Run directly against a provider; all results stay in the console report. */
export async function runDaxBenchmark(provider: ProviderConfig, iterations: number): Promise<DaxTimingResult[]> {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error('Iterations must be a positive integer');
  }
  const missing = provider.requiredEnvVars.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing credentials for ${provider.name}: ${missing.join(', ')}`);
  }

  const results: DaxTimingResult[] = [];
  for (let i = 0; i < iterations; i++) {
    console.log(`[${provider.name}] Iteration ${i + 1}/${iterations}`);
    let sandbox: any;
    // If creation times out but eventually succeeds, still dispose of the sandbox.
    let creationExpired = false;
    const destroy = async (instance: { destroy(): Promise<unknown> }) => {
      try {
        await withTimeout(instance.destroy(), provider.destroyTimeoutMs ?? 15_000, 'Destroy timeout');
      } catch (error) {
        console.warn(`[${provider.name}] Cleanup failed: ${formatError(error)}`);
      }
    };
    let result: DaxTimingResult;
    try {
      const compute = provider.createCompute();
      const creation = Promise.resolve(compute.sandbox.create(
        getSandboxOptionsWithResources(provider.name, provider.sandboxOptions),
      )).then(async instance => {
        if (creationExpired) await destroy(instance);
        return instance;
      });
      try {
        sandbox = await withTimeout(creation, provider.timeout ?? 600_000, 'Sandbox creation timed out');
      } catch (error) {
        creationExpired = true;
        throw error;
      }
      result = await runDaxBuild(sandbox, provider.name, provider.timeout ?? 600_000);
    } catch (error) {
      result = { totalMs: 0, error: formatError(error) };
    } finally {
      if (sandbox) await destroy(sandbox);
    }
    results.push(result);
    console.log(result.error ? `FAILED: ${result.error}` : `OK: ${(result.totalMs / 1000).toFixed(2)}s`);
  }
  return results;
}

export function printDaxReport(provider: string, results: DaxTimingResult[]): void {
  const seconds = (ms: number | undefined) => ms === undefined ? '--' : `${(ms / 1000).toFixed(2)}s`;
  console.log(`\nDAX report: ${provider}`);
  console.table(results.map((result, i) => ({
    Iteration: i + 1,
    Status: result.error ? 'FAIL' : 'OK',
    Phases: `${result.phasesCompleted ?? 0}/${result.phasesTotal ?? 7}`,
    Total: result.totalMs > 0 ? seconds(result.totalMs) : '--',
    Prepare: seconds(result.prepareMs),
    'Cache clear': seconds(result.cacheClearMs),
    'Bun download': seconds(result.bunDownloadMs),
    'Bun unpack': seconds(result.bunUnpackMs),
    Clone: seconds(result.cloneMs),
    Install: seconds(result.installMs),
    Typecheck: seconds(result.typecheckMs),
  })));
  const successful = results.filter(result => !result.error);
  console.log(`Succeeded: ${successful.length}/${results.length}`);
  if (successful.length > 0) {
    const summary = summarize(successful);
    console.log(`Successful build totals: median ${seconds(summary.totalMs.median)}, p95 ${seconds(summary.totalMs.p95)}, p99 ${seconds(summary.totalMs.p99)}`);
  }
  results.forEach((result, i) => {
    if (result.error) console.log(`Iteration ${i + 1}: ${result.error}`);
    if (result.commit) console.log(`Iteration ${i + 1} commit: ${result.commit}`);
  });
}
