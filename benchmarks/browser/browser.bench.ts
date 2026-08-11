/**
 * Browser lifecycle benchmark: `iterations` create→connect→navigate→release
 * cycles per provider (concurrency 1 = sequential). Declarative — exports
 * `config` + `task`; `bench run` owns the entrypoint.
 *
 *   bench run benchmarks/browser/browser.bench.ts
 *   bench run benchmarks/browser/browser.bench.ts --iterations 5 --provider browserbase
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { browserProviders } from './providers.js';
import type { BrowserProviderConfig } from './types.js';
import { writeBrowserLegacyResults } from './legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const browserTimeoutMs = browserProviders.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'browser-lifecycle',
  benchmarkName: 'Browser Lifecycle',
  benchmarkKind: 'browser',
  iterations: 2,
  concurrency: 1,
  participants: browserProviders,
  onComplete: (outcome) =>
    writeBrowserLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/browser'),
      timeoutMs: browserTimeoutMs,
    }),
});

/** One provider instance per participant, reused across that provider's iterations. */
const providerCache = new Map<string, any>();

export const task = defineTask<BrowserProviderConfig>(async (ctx) => {
  const { participant, step } = ctx;
  const timeout = participant.timeout ?? 120_000;
  const sessionCreateOptions = participant.sessionCreateOptions ?? {};

  let provider = providerCache.get(participant.name);
  if (!provider) {
    provider = participant.createBrowserProvider();
    providerCache.set(participant.name, provider);
  }

  const timings = { createMs: 0, connectMs: 0, navigateMs: 0, releaseMs: 0, totalMs: 0 };
  const totalStart = performance.now();
  let session: { sessionId: string; connectUrl: string } | undefined;
  let browser: any;

  try {
    const createStart = performance.now();
    session = (await step('create', () =>
      withTimeout(provider.session.create(sessionCreateOptions), timeout, 'Session creation timed out'),
    )) as { sessionId: string; connectUrl: string };
    timings.createMs = performance.now() - createStart;

    try {
      const connectStart = performance.now();
      const page = await step('connect', async () => {
        browser = await withTimeout(
          chromium.connectOverCDP(session!.connectUrl),
          30_000,
          'CDP connection timed out',
        );
        const [context] = browser.contexts();
        if (!context) throw new Error('No default browser context found');
        const [p] = context.pages();
        if (!p) throw new Error('No default page found');
        return p;
      });
      timings.connectMs = performance.now() - connectStart;

      const navStart = performance.now();
      await step('navigate', () =>
        withTimeout(
          page.goto('https://www.example.com', { waitUntil: 'load' }),
          30_000,
          'Navigation timed out',
        ),
      );
      timings.navigateMs = performance.now() - navStart;
    } finally {
      if (browser) await browser.close().catch(() => {});
      const releaseStart = performance.now();
      await step(
        'release',
        () => withTimeout(provider.session.destroy(session!.sessionId), 15_000, 'Session destroy timed out'),
        { reportConcurrency: false },
      );
      timings.releaseMs = performance.now() - releaseStart;
    }

    timings.totalMs = performance.now() - totalStart;
    return { data: { ...timings } };
  } catch (err) {
    timings.totalMs = performance.now() - totalStart;
    const message = err instanceof Error ? err.message : String(err);
    throw new TaskError(message, { code: 'BROWSER_ERROR', data: { ...timings, errorMessage: message } });
  }
});
