---
"@benchsdk/client": minor
---

Add participant helpers to the public API: the `BaseParticipant` type plus `selectParticipants()` (filter by `--provider` names) and `filterParticipantsByEnv()` (split participants by whether their `requiredEnvVars` are set).
