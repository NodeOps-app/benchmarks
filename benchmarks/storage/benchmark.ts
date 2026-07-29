import crypto from 'crypto';
import type { Storage } from '@storagesdk/core';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { round, roundStats, computeStats as computeStorageStats } from './stats.js';
import type { StorageProviderConfig, StorageBenchmarkResult, StorageTimingResult } from './types.js';


export async function writeStorageResultsJson(results: StorageBenchmarkResult[], outPath: string): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    bucket: r.bucket,
    fileSizeBytes: r.fileSizeBytes,
    iterations: r.iterations.map(i => ({
      uploadMs: round(i.uploadMs),
      downloadMs: round(i.downloadMs),
      throughputMbps: round(i.throughputMbps),
      fileSizeBytes: i.fileSizeBytes,
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      uploadMs: roundStats(r.summary.uploadMs),
      downloadMs: roundStats(r.summary.downloadMs),
      throughputMbps: roundStats(r.summary.throughputMbps),
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.1',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      iterations: results[0]?.iterations.length || 0,
      timeoutMs: 30000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
