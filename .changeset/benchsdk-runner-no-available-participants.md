---
"@benchsdk/runner": patch
---

`runBenchmark()` now rejects with the exported `NoAvailableParticipantsError` (carrying the `skipped` participants and their missing env vars) instead of a plain `Error` when every participant is env-gated out, so callers can treat an unprovisioned provider as a skip rather than a failure.
