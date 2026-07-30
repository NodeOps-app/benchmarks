---
"@benchsdk/runner": minor
---

Add `--slug` and `--name` CLI overrides for `benchmarkSlug`/`benchmarkName`, so one `*.bench.ts` can report under several platform benchmarks (e.g. the sandbox TTI entrypoint reporting sequential/staggered/burst runs of the same workload).
