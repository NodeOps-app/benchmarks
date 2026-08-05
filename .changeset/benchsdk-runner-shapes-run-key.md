---
"@benchsdk/runner": minor
---

Verbs-only CLI: `bench run <file.bench.ts>` is the one mutating command. The benchmark is declared in the file and materialized (upserted) as a side effect of running it, and a run is opened as a side effect too — there are no imperative `bench create benchmark` / `bench create run` commands.

`bench run` gains `--shape <name>`: a bench file can declare named `shapes`, each swapping in its own platform identity (`slug`/`name`, optional `kind`) and a stable knob (`staggerDelayMs`) while reusing the same task and participants. This collapses the per-shape slug/name/knob triple that was duplicated across package scripts and CI.

`bench run` gains `--run-key <key>`: sibling processes passing the same key (per org + benchmark) get-or-create one shared run instead of each opening its own, so provider jobs running in parallel land in a single, directly-comparable run. Each process registers only the participants it runs. The key binding is permanent, so callers that need a fresh run (e.g. a CI re-run) vary the key (e.g. include `GITHUB_RUN_ATTEMPT`).

`--slug` remains a working alias for `--benchmark`.
