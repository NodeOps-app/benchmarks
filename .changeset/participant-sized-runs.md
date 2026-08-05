---
"@benchsdk/client": minor
---

`createRun` no longer requires `totalTasks`: omit it to open a participant-sized run, whose total is the sum of what its participants declare when they register. `BenchmarkRun.participantSized` reports which kind a run is.
