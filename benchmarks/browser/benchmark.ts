import { chromium } from 'playwright-core';
import { withTimeout } from '../src/util/timeout.js';
import type { BrowserProviderConfig, BrowserBenchmarkResult, BrowserTimingResult } from './types.js';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}


function roundStats(s: { median: number; p95: number; p99: number }) {
  return { median: round(s.median), p95: round(s.p95), p99: round(s.p99) };
}

export async function writeBrowserResultsJson(
  results: BrowserBenchmarkResult[],
  outPath: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map(i => ({
      createMs: round(i.createMs),
      connectMs: round(i.connectMs),
      navigateMs: round(i.navigateMs),
      releaseMs: round(i.releaseMs),
      totalMs: round(i.totalMs),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      createMs: roundStats(r.summary.createMs),
      connectMs: roundStats(r.summary.connectMs),
      navigateMs: roundStats(r.summary.navigateMs),
      releaseMs: roundStats(r.summary.releaseMs),
      totalMs: roundStats(r.summary.totalMs),
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  // Derive iteration count from the largest run across providers, so a
  // skipped first provider doesn't make the header read 0.
  const iterations = results.reduce((max, r) => Math.max(max, r.iterations.length), 0);

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      iterations,
      timeoutMs: options.timeoutMs ?? 120_000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
