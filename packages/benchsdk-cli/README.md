# @benchsdk/cli

Benchmark runner framework for building self-contained benchmark scripts that report to the benchmarks platform via [`@benchsdk/client`](../benchsdk).

## What it provides

- **`LogBuffer`** — Accumulates one text log per worker across a sandbox lifecycle's steps (create → exec → destroy) and uploads it once via `runWorker`'s `onFinish` hook as a `coordinator.log` artifact.
- **`uploadWorkerLog`** — Uploads a `LogBuffer` as a `coordinator.log` artifact; never throws.
- **`loggedStep`** — Runs a function through both the platform step reporter and the local log buffer, so failures show up in both places without duplicating try/catch at every call site.
- **`defineBenchmark`** / **`runBenchmark`** — Declarative config for a self-contained `*.bench.ts` file plus the runner that turns it into platform runs. There is no "mode": the orchestration shape (sequential / staggered / burst) emerges from the `iterations`, `concurrency`, and `staggerDelayMs` knobs, and `groupBy` (`'participant'` | `'round'`) selects the ordering across participants.

## Install

```sh
pnpm add @benchsdk/cli @benchsdk/client
```

## Usage

```ts
import { defineBenchmark, runBenchmark } from '@benchsdk/cli';

const config = defineBenchmark({
  benchmarkSlug: 'sandbox-tti-local',
  benchmarkName: 'Sandbox TTI (local)',
  benchmarkKind: 'sandbox',
  iterations: 100,   // total tasks per participant
  concurrency: 1,    // 1 = sequential, N = burst
  task: async ({ participant, step }) => {
    const sandbox = await step('create', () => participant.createCompute().sandbox.create());
    await step('exec.task', () => sandbox.runCommand('node -v'));
    await step('destroy', () => sandbox.destroy());
    return { data: { ttiMs } };
  },
});

// CLI flags (--iterations, --concurrency, --stagger-delay-ms, --group-by,
// --provider a,b) override the config defaults.
runBenchmark(config, participants, process.argv.slice(2));
```

`LogBuffer` / `loggedStep` / `uploadWorkerLog` accumulate one text log per worker and
upload it once as a `coordinator.log` artifact:

```ts
import { LogBuffer, loggedStep, uploadWorkerLog } from '@benchsdk/cli';

const logBuffer = new LogBuffer();
await loggedStep(ctx, logBuffer, 'create sandbox', async () => sandbox.create());
await uploadWorkerLog(ctx, logBuffer, 'my-provider');
```

## License

MIT
