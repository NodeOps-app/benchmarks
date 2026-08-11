/**
 * AI Gateway benchmark. Declarative — exports `config` + `task`; `bench run`
 * owns the entrypoint. Configured with `groupBy: 'round'`. Fairness is the
 * whole point (see AI_GATEWAYS.md): every gateway's Nth iteration must run at
 * roughly the same point in time as every other gateway's Nth iteration, so no
 * gateway is favored by running during a different network condition.
 * `groupBy: 'round'` provides exactly that — one task per gateway per round,
 * taking turns — replacing the bespoke round-robin loop this file used to
 * hand-roll.
 *
 * Declared as two phases (cold, warm); the framework owns the phase boundary
 * and exposes it via `ctx.phase`, so the task branches on phase identity, not
 * index arithmetic. Each phase runs a socket-level probe (cold: fresh
 * connection with DNS/TCP/TLS + TTFB/TTFT; warm: reused connection, TTFB/TTFT
 * only). Phase timings are measured inside a single request, so they're
 * returned as pre-measured `TaskResult.steps`, and the real measured latency
 * (coldE2eMs / ttftMs) is returned as `TaskResult.latencyMs` rather than
 * letting the framework stamp wall-clock time.
 *
 * Run:
 *   bench run benchmarks/ai-gateway/ai-gateway.bench.ts
 *   bench run benchmarks/ai-gateway/ai-gateway.bench.ts --provider openrouter
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { TaskContext, TaskResult } from '@benchsdk/runner';
import type { JsonObject, TaskStepRecord } from '@benchsdk/client';
import { runColdProbe, runWarmProbe } from './phase-probe.js';
import { providers } from './providers.js';
import type { AIGatewayProviderConfig, PhaseProbeResult } from './types.js';
import { writeAIGatewayLegacyResults } from './legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This bench declares phases, so the runner ignores the generic `--iterations`
// (it warns and derives iterations from the phase totals). Parse the per-phase
// iteration knobs here so they stay CLI-overridable (mirrors run.ts):
// `--iterations N` sets both cold and warm, while
// `--ai-gateway-iterations-cold/-warm` override each independently.
function parseIntFlag(argv: string[], flag: string): number | undefined {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) {
    const n = Number(argv[idx + 1]);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) {
    const n = Number(eq.slice(flag.length + 1));
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return undefined;
}

const argv = process.argv.slice(2);
const iterationsOverride = parseIntFlag(argv, '--iterations');
// Request parameters match run.ts's AI Gateway defaults exactly (identical
// across every gateway is load-bearing for fairness — see AI_GATEWAYS.md).
const ITERATIONS_COLD = parseIntFlag(argv, '--ai-gateway-iterations-cold') ?? iterationsOverride ?? 10;
const ITERATIONS_WARM = parseIntFlag(argv, '--ai-gateway-iterations-warm') ?? iterationsOverride ?? 10;
const PROMPT = 'Write a two-sentence description of how distributed systems handle partial failures.';
const MAX_TOKENS = 200;
const TIMEOUT_MS = 45_000;

/** Builds DNS/TCP/TLS (cold only) + TTFB/TTFT as pre-measured platform steps. */
function phaseSteps(result: PhaseProbeResult): TaskStepRecord[] {
  const stepStatus: TaskStepRecord['status'] = result.error ? 'error' : 'success';
  const steps: TaskStepRecord[] = [];
  if (result.mode === 'cold') {
    if (result.dnsMs !== undefined) steps.push({ name: 'dns', status: 'success', latencyMs: result.dnsMs });
    if (result.tcpMs !== undefined) steps.push({ name: 'tcp', status: 'success', latencyMs: result.tcpMs });
    if (result.tlsMs !== undefined) steps.push({ name: 'tls', status: 'success', latencyMs: result.tlsMs });
  }
  steps.push({ name: 'ttfb', status: stepStatus, latencyMs: result.ttfbMs });
  // Token throughput/count are non-latency metrics (a rate the step's latency
  // can't express), so attach them to the ttft step's data → step_data_json.
  const ttftData: JsonObject = {
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.outputTokensPerSec !== undefined ? { outputTokensPerSec: result.outputTokensPerSec } : {}),
  };
  steps.push({
    name: 'ttft',
    status: stepStatus,
    latencyMs: result.ttftMs,
    ...(Object.keys(ttftData).length > 0 ? { data: ttftData } : {}),
  });
  return steps;
}

function probeData(result: PhaseProbeResult): JsonObject {
  return {
    mode: result.mode,
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.outputTokensPerSec !== undefined ? { outputTokensPerSec: result.outputTokensPerSec } : {}),
    ...(result.receipts && Object.keys(result.receipts).length > 0 ? { receipts: result.receipts } : {}),
    ...(result.error ? { errorMessage: result.error } : {}),
  };
}

async function aiGatewayTask(ctx: TaskContext<AIGatewayProviderConfig>): Promise<TaskResult> {
  const isCold = ctx.phase === 'cold';
  const result = isCold
    ? await runColdProbe(ctx.participant, PROMPT, MAX_TOKENS, TIMEOUT_MS)
    : await runWarmProbe(ctx.participant, PROMPT, MAX_TOKENS, TIMEOUT_MS);

  const steps = phaseSteps(result);

  if (result.error) {
    ctx.log(`${ctx.participant.name} ${result.mode} probe failed: ${result.error}`, probeData(result));
    throw new TaskError(result.error, { code: 'probe_failed', data: probeData(result), steps });
  }
  ctx.log(
    `${ctx.participant.name} ${result.mode} probe: ttfb=${result.ttfbMs}ms ttft=${result.ttftMs}ms`,
    probeData(result),
  );
  return {
    data: probeData(result),
    steps,
    latencyMs: isCold ? result.coldE2eMs ?? result.ttftMs : result.ttftMs,
  };
}

// The CLI asserts every phase has iterations >= 1, but run.ts historically
// allowed a phase to be dialed to 0 (e.g. `--ai-gateway-iterations-warm 0` to
// skip the warm phase entirely). Preserve that by dropping any zeroed phase
// before it reaches the runner.
const phases = [
  { name: 'cold', iterations: ITERATIONS_COLD },
  { name: 'warm', iterations: ITERATIONS_WARM },
].filter((p) => p.iterations > 0);

if (phases.length === 0) {
  console.log('Both phases are zeroed — nothing to run.');
  process.exit(0);
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'ai-gateway-latency',
  benchmarkName: 'AI Gateway Latency',
  benchmarkKind: 'ai-gateway',
  phases,
  groupBy: 'round',
  participants: providers,
  onComplete: (outcome) =>
    writeAIGatewayLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/ai-gateway'),
      providers,
    }),
});

export const task = defineTask(aiGatewayTask);
