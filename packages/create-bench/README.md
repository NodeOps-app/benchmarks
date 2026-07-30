# create-bench

Scaffold a new ComputeSDK benchmark project that uses [`@benchsdk/client`](https://github.com/computesdk/benchmarks/tree/master/packages/benchsdk).

## Usage

```sh
npx create-bench my-benchmark
```

Or with npm:

```sh
npm create bench my-benchmark
```

## What gets created

The CLI creates a directory with the given project name and writes:

- `package.json` — with `@benchsdk/client`, `tsx`, and benchmark scripts
- `tsconfig.json` — basic TypeScript configuration
- `bench.ts` — a minimal benchmark worker using `createBenchmarkClient().runWorker()`
- `.env.example` — environment variables to configure the worker
- `README.md` — instructions for the new project

## Next steps

1. `cd my-benchmark`
2. `pnpm install`
3. Copy `.env.example` to `.env` and fill in the required values
4. `pnpm bench`
