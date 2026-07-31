---
"@benchsdk/client": minor
---

Make `@benchsdk/client` a pure REST + worker-engine package. The benchmark authoring factories `defineStep`, `defineTask`, `defineWorker`, `defineBench`, and the `runBenchmarkWorker` free function have been removed — that authoring model now lives in `@benchsdk/runner`. `client.runWorker({ task })` now accepts a raw `TaskFunction` whose context exposes `step(...)` (imperative named steps), `measure(data)` (explicit metrics — merged into the active step's data, or the task record outside a step; a task with no explicit steps is recorded as one implicit `'task'` step carrying its measurements, and measurements are preserved when a task throws), and `log(message, meta?)` (buffered per worker and uploaded once as a `worker.log` artifact). `createBenchmarkClient`, the REST methods, `BenchmarkReporter`, and the system-metrics collector are unchanged.
