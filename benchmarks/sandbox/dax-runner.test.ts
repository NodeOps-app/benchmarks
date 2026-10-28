import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderConfig } from './types.js';
import { printDaxReport, runDaxBenchmark } from './dax-runner.js';

const successOutput = [
  'BENCH_PHASE\tprepare\t100',
  'BENCH_PHASE\tcache_clear\t10',
  'BENCH_PHASE\tbun_download\t200',
  'BENCH_PHASE\tbun_unpack\t50',
  'BENCH_PHASE\tclone\t300',
  'BENCH_PHASE\tinstall\t400',
  'BENCH_PHASE\ttypecheck\t500',
  'BENCH_DONE\ttest-commit',
].join('\n');

test('runs with provider credentials only, preserves DAX sizing, and destroys every sandbox', async () => {
  let destroyed = 0;
  const provider: ProviderConfig = {
    name: 'createos',
    requiredEnvVars: [],
    sandboxOptions: { rootfs: 'test-image' },
    createCompute: () => ({ sandbox: {
      create: async (options: Record<string, unknown>) => {
        assert.deepEqual(options, { rootfs: 'test-image', shape: 's-8vcpu-16gb', ephemeralDiskMb: 61440 });
        return {
          runCommand: async (command: string) => {
            assert.match(command, /BENCH_PROVIDER=createos/);
            return { exitCode: 0, stdout: successOutput };
          },
          destroy: async () => { destroyed++; },
        };
      },
    } }),
  };
  const results = await runDaxBenchmark(provider, 2);
  assert.equal(destroyed, 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].phasesCompleted, 7);
  assert.equal(results[0].installMs, 400);
  assert.equal(results[0].commit, 'test-commit');
  assert.equal(results[0].error, undefined);
});

test('reports a failed phase and continues subsequent iterations with cleanup', async () => {
  let destroyed = 0;
  let calls = 0;
  const provider: ProviderConfig = {
    name: 'test', requiredEnvVars: [],
    createCompute: () => ({ sandbox: { create: async () => ({
      runCommand: async () => ++calls === 1
        ? { exitCode: 1, stdout: 'BENCH_PHASE\tprepare\t100\nBENCH_PHASE\tcache_clear\t10', stderr: 'BENCH_ERROR\tcache failed' }
        : { exitCode: 0, stdout: successOutput },
      destroy: async () => { destroyed++; },
    }) } }),
  };
  const results = await runDaxBenchmark(provider, 2);
  assert.equal(results[0].error, 'cache failed');
  assert.equal(results[0].phasesCompleted, 1);
  assert.equal(results[0].cacheClearMs, undefined);
  assert.equal(results[1].error, undefined);
  assert.equal(destroyed, 2);
});

test('records creation and command exceptions without losing the remaining report', async () => {
  let attempts = 0;
  let destroyed = 0;
  const provider: ProviderConfig = {
    name: 'test', requiredEnvVars: [],
    createCompute: () => ({ sandbox: { create: async () => {
      if (++attempts === 1) throw new Error('creation failed');
      return {
        runCommand: async () => { throw new Error('command failed'); },
        destroy: async () => { destroyed++; },
      };
    } } }),
  };
  const results = await runDaxBenchmark(provider, 2);
  assert.match(results[0].error!, /creation failed/);
  assert.match(results[1].error!, /command failed/);
  assert.equal(destroyed, 1);
});

test('cleans up a sandbox that arrives after creation times out', async () => {
  let resolveCreation!: (sandbox: unknown) => void;
  let resolveDestroyed!: () => void;
  const destroyed = new Promise<void>(resolve => { resolveDestroyed = resolve; });
  const provider: ProviderConfig = {
    name: 'test', requiredEnvVars: [], timeout: 5,
    createCompute: () => ({ sandbox: { create: () => new Promise(resolve => { resolveCreation = resolve; }) } }),
  };
  const results = await runDaxBenchmark(provider, 1);
  assert.match(results[0].error!, /Sandbox creation timed out/);
  resolveCreation({ destroy: async () => { resolveDestroyed(); } });
  await destroyed;
});

test('rejects invalid iterations and missing credentials before creating sandboxes', async () => {
  const provider: ProviderConfig = {
    name: 'test', requiredEnvVars: ['DAX_TEST_MISSING_CREDENTIAL'],
    createCompute: () => { throw new Error('must not create'); },
  };
  await assert.rejects(runDaxBenchmark(provider, 0), /positive integer/);
  await assert.rejects(runDaxBenchmark(provider, 1.5), /positive integer/);
  await assert.rejects(runDaxBenchmark(provider, 1), /Missing credentials.*DAX_TEST_MISSING_CREDENTIAL/);
});

test('prints failures and excludes failed builds from successful timing statistics', context => {
  const log = context.mock.method(console, 'log', () => {});
  const table = context.mock.method(console, 'table', () => {});
  printDaxReport('test', [
    { totalMs: 1000, phasesCompleted: 7, phasesTotal: 7 },
    { totalMs: 9000, error: 'install failed', phasesCompleted: 5, phasesTotal: 7 },
  ]);
  const lines = log.mock.calls.map(call => call.arguments.join(' ')).join('\n');
  assert.match(lines, /Succeeded: 1\/2/);
  assert.match(lines, /median 1.00s/);
  assert.match(lines, /Iteration 2: install failed/);
  assert.equal(table.mock.calls.length, 1);
});
