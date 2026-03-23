import crypto from 'crypto';
import type { StorageProviderConfig, StorageBenchmarkResult, StorageTimingResult, StorageStats } from './types.js';

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(idx, sorted.length - 1)];
}

function computeStorageStats(values: number[]): { median: number; p95: number; p99: number } {
  if (values.length === 0) return { median: 0, p95: 0, p99: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * 0.05);
  const trimmed = trimCount > 0 && sorted.length - 2 * trimCount > 0
    ? sorted.slice(trimCount, sorted.length - trimCount)
    : sorted;

  const mid = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];

  return {
    median,
    p95: percentile(trimmed, 95),
    p99: percentile(trimmed, 99),
  };
}

function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then(v => { clearTimeout(timer); return v; }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

async function runStorageIteration(
  storage: any,
  bucket: string,
  fileSizeBytes: number,
  timeout: number
): Promise<StorageTimingResult> {
  const testData = crypto.randomBytes(fileSizeBytes);
  const key = `benchmark-${Date.now()}-${randomId()}`;

  try {
    // Upload timing
    const uploadStart = performance.now();
    await withTimeout(
      storage.upload(bucket, key, testData),
      timeout,
      'Upload timed out'
    );
    const uploadMs = performance.now() - uploadStart;

    // Download timing
    const downloadStart = performance.now();
    await withTimeout(
      storage.download(bucket, key),
      timeout,
      'Download timed out'
    );
    const downloadMs = performance.now() - downloadStart;

    // Calculate throughput (Mbps)
    const throughputMbps = (fileSizeBytes * 8) / (downloadMs / 1000) / 1_000_000;

    // Cleanup
    try {
      await withTimeout(
        storage.delete(bucket, key),
        10000,
        'Delete timed out'
      );
    } catch (err) {
      console.warn(`    [cleanup] delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { uploadMs, downloadMs, throughputMbps, fileSizeBytes };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    
    // Attempt cleanup even on failure
    try {
      await storage.delete(bucket, key);
    } catch {
      // Ignore cleanup errors
    }

    return { uploadMs: 0, downloadMs: 0, throughputMbps: 0, fileSizeBytes, error };
  }
}

export async function runStorageBenchmark(config: StorageProviderConfig, fileSizeBytes: number): Promise<StorageBenchmarkResult> {
  const { name, iterations = 100, timeout = 30000, requiredEnvVars, createStorage, bucket } = config;

  // Check if all required credentials are available
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'storage',
      bucket,
      fileSizeBytes,
      iterations: [],
      summary: {
        uploadMs: { median: 0, p95: 0, p99: 0 },
        downloadMs: { median: 0, p95: 0, p99: 0 },
        throughputMbps: { median: 0, p95: 0, p99: 0 },
      },
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const storage = createStorage();
  const results: StorageTimingResult[] = [];
  const fileSizeLabel = `${(fileSizeBytes / 1024 / 1024).toFixed(0)}MB`;

  console.log(`\n--- Storage Benchmarking: ${name} (${fileSizeLabel}, ${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);

    try {
      const iterationResult = await runStorageIteration(storage, bucket, fileSizeBytes, timeout);
      results.push(iterationResult);

      if (iterationResult.error) {
        console.log(`    FAILED: ${iterationResult.error}`);
      } else {
        console.log(`    Upload: ${(iterationResult.uploadMs / 1000).toFixed(2)}s, Download: ${(iterationResult.downloadMs / 1000).toFixed(2)}s, Throughput: ${iterationResult.throughputMbps.toFixed(2)} Mbps`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`    FAILED: ${error}`);
      results.push({ uploadMs: 0, downloadMs: 0, throughputMbps: 0, fileSizeBytes, error });
    }
  }

  const successful = results.filter(r => !r.error);

  // If every iteration failed, mark as skipped
  if (successful.length === 0) {
    return {
      provider: name,
      mode: 'storage',
      bucket,
      fileSizeBytes,
      iterations: results,
      summary: {
        uploadMs: { median: 0, p95: 0, p99: 0 },
        downloadMs: { median: 0, p95: 0, p99: 0 },
        throughputMbps: { median: 0, p95: 0, p99: 0 },
      },
      skipped: true,
      skipReason: 'All iterations failed',
    };
  }

  const uploadTimes = successful.map(r => r.uploadMs);
  const downloadTimes = successful.map(r => r.downloadMs);
  const throughputs = successful.map(r => r.throughputMbps);

  return {
    provider: name,
    mode: 'storage',
    bucket,
    fileSizeBytes,
    iterations: results,
    summary: {
      uploadMs: computeStorageStats(uploadTimes),
      downloadMs: computeStorageStats(downloadTimes),
      throughputMbps: computeStorageStats(throughputs),
    },
  };
}
