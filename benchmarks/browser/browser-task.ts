/**
 * Shared browser-lifecycle workload for the browser benchmark. One iteration =
 * create a session, connect over CDP, navigate to example.com, then release
 * (always, even on failure). Orchestration (how many, how parallel) is owned by
 * @benchsdk/cli's runBenchmark — this file only describes what one iteration
 * does.
 */
import { chromium } from 'playwright-core';
import type { BenchmarkTask, TaskContext, TaskResult } from '@benchsdk/cli';
import { TaskError } from '@benchsdk/cli';
import { withTimeout } from '../src/util/timeout.js';
import type { BrowserProviderConfig } from './types.js';

/**
 * Build a browser task that caches one provider instance per participant name
 * (the legacy benchmark created the provider once per provider).
 */
export function makeBrowserTask(): BenchmarkTask<BrowserProviderConfig> {
  const providerCache = new Map<string, any>();

  return async function browserTask(ctx: TaskContext<BrowserProviderConfig>): Promise<TaskResult> {
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
  };
}
