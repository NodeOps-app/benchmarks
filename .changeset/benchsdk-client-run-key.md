---
"@benchsdk/client": minor
---

`createRun` accepts an optional `runKey`: callers passing the same key (per org + benchmark) get-or-create one shared run instead of each opening its own. `BenchmarkRun.runKey` reports the key a run was created with.
