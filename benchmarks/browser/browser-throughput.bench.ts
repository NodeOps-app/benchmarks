/**
 * Browser throughput benchmark: each session runs a fixed action loop; sessions
 * are interleaved across providers (groupBy 'round') so every provider runs its
 * Nth session against the same article before anyone starts their (N+1)th.
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * The session lifecycle (create / connect / actions / release) runs as real
 * framework steps via `ctx.step`, so the platform records each phase's true
 * timing and status. `actionsPerSecond`/`actionsCompleted` are non-latency
 * throughput metrics, so they're reported with `ctx.measure` inside `actions`.
 *
 *   bench run benchmarks/browser/browser-throughput.bench.ts
 *   bench run benchmarks/browser/browser-throughput.bench.ts --iterations 5 --provider browserbase
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { JsonValue } from '@benchsdk/client';
import { withTimeout } from '../src/util/timeout.js';
import { throughputProviders } from './throughput-providers.js';
import { writeThroughputLegacyResults } from './browser-throughput-legacy-results.js';
import { ACTIONS_PER_LOOP, LOOPS_PER_SESSION } from './throughput-types.js';
import type { ActionResult, ThroughputProviderConfig } from './throughput-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const throughputTimeoutMs =
  throughputProviders.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'browser-throughput-local',
  benchmarkName: 'Browser Throughput (local)',
  benchmarkKind: 'browser',
  iterations: 2,
  groupBy: 'round',
  participants: throughputProviders,
  onComplete: (outcome) =>
    writeThroughputLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/browser-throughput'),
      timeoutMs: throughputTimeoutMs,
    }),
});

const RANDOM_URL = 'https://en.wikipedia.org/wiki/Special:Random';
const FIRST_HEADING = '#firstHeading';
const ACTION_TIMEOUT_MS = 30_000;

// Match article-body links across classic MediaWiki HTML (relative "/wiki/Foo"),
// Parsoid read-HTML (protocol-relative "//en.wikipedia.org/wiki/Foo"), and the
// newer absolute form ("https://en.wikipedia.org/wiki/Foo").
// We can't use :not([href*=":"]) because that also rejects https: URLs. Instead
// we select all /wiki/ links in the content area and filter in JS by checking
// that the path segment after /wiki/ has no namespace colon (Help:, File:, etc.).
const ARTICLE_LINK_SELECTOR = '#mw-content-text a[href*="/wiki/"]';

// Providers must be benchmarked against the same pages to be comparable, but in
// CI each provider runs as a separate job/process — so `Special:Random` makes
// each one draw different articles. The workflow resolves one concrete article
// URL per iteration up front and injects the list via THROUGHPUT_URLS (a JSON
// array). Iteration i then navigates to urls[i] for *every* provider: the same
// page across providers, but a different page each iteration so we don't measure
// a warmed cache. Absent the env var (local runs), navigation stays random.
const NAV_URLS: string[] = parseNavUrls();

function parseNavUrls(): string[] {
  const raw = process.env.THROUGHPUT_URLS?.trim();
  if (!raw) return [];
  // Accept either a JSON array or a plain newline/whitespace-delimited list, so
  // the workflow can emit the URLs with pure bash and not depend on jq/python
  // being present on the runner image.
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((u): u is string => typeof u === 'string' && u.length > 0);
    } catch {
      // Malformed JSON falls through to whitespace splitting below.
    }
  }
  return raw.split(/\s+/).filter(u => u.length > 0);
}

/** The article URL iteration `i` should navigate to (same across providers). */
function navUrlForIteration(i: number): string {
  if (NAV_URLS.length > 0) return NAV_URLS[i % NAV_URLS.length];
  return RANDOM_URL;
}

/** Returns true if an href points to a real article (not a namespace page). */
function isArticleLink(href: string | null): boolean {
  if (!href) return false;
  const match = href.match(/\/wiki\/([^#]*)/);
  if (!match) return false;
  return !match[1].includes(':');
}

async function timeAction<T>(
  fn: () => Promise<T>,
): Promise<{ durationMs: number; success: boolean; error?: string; value?: T }> {
  const start = performance.now();
  try {
    const value = await withTimeout(fn(), ACTION_TIMEOUT_MS, 'Action timed out');
    return { durationMs: performance.now() - start, success: true, value };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { durationMs: performance.now() - start, success: false, error };
  }
}

async function runActionLoop(page: Page, results: ActionResult[], navigateUrl: string): Promise<void> {
  for (let loop = 0; loop < LOOPS_PER_SESSION; loop++) {
    const baseIdx = loop * ACTIONS_PER_LOOP;

    // 1. Navigate to the article for this iteration (shared across providers)
    {
      const r = await timeAction(() =>
        page.goto(navigateUrl, { waitUntil: 'load' }) as Promise<unknown>,
      );
      results.push({ index: baseIdx + 1, type: 'navigate', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 2. Wait for #firstHeading
    {
      const r = await timeAction(() => page.waitForSelector(FIRST_HEADING));
      results.push({ index: baseIdx + 2, type: 'waitForSelector', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 3. Screenshot
    {
      const r = await timeAction(() => page.screenshot());
      results.push({ index: baseIdx + 3, type: 'screenshot', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 4. Read text content of #firstHeading
    {
      const r = await timeAction(() => page.textContent(FIRST_HEADING));
      results.push({ index: baseIdx + 4, type: 'textContent', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 5. Click first article link (filter out meta pages like Help:, File:, etc.)
    let clickSucceeded = false;
    {
      const r = await timeAction(async () => {
        // Wait for any /wiki/ link to appear, then filter in JS for article
        // links (no namespace colon after /wiki/). This handles relative,
        // protocol-relative, and absolute https:// URL formats.
        await page.waitForSelector(ARTICLE_LINK_SELECTOR, { timeout: 10_000 });
        const links = await page.$$(ARTICLE_LINK_SELECTOR);
        for (const link of links) {
          const href = await link.getAttribute('href');
          if (isArticleLink(href)) {
            await link.click();
            return;
          }
        }
        throw new Error('No article body link found on page');
      });
      clickSucceeded = r.success;
      results.push({ index: baseIdx + 5, type: 'click', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // If the click failed (e.g. stub article with no body links), skip the
    // remaining actions that depend on having navigated to a new page.
    // Without this, goBack navigates to a blank page and the final
    // waitForSelector times out for 30s, inflating task time.
    if (!clickSucceeded) {
      for (const idx of [6, 7, 8, 9, 10]) {
        results.push({ index: baseIdx + idx, type: idx <= 8 ? (idx === 6 || idx === 10 ? 'waitForSelector' : idx === 7 ? 'screenshot' : 'textContent') : 'goBack', durationMs: 0, success: false, error: 'skipped: click failed' });
      }
      continue;
    }

    // 6. Wait for #firstHeading on the new page
    {
      const r = await timeAction(() => page.waitForSelector(FIRST_HEADING));
      results.push({ index: baseIdx + 6, type: 'waitForSelector', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 7. Screenshot the new page
    {
      const r = await timeAction(() => page.screenshot());
      results.push({ index: baseIdx + 7, type: 'screenshot', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 8. Read text content of #firstHeading on the new page
    {
      const r = await timeAction(() => page.textContent(FIRST_HEADING));
      results.push({ index: baseIdx + 8, type: 'textContent', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 9. Go back. Use `waitUntil: 'commit'` because back-forward cache restores
    // fire `pageshow` instead of `load`, and Playwright's default
    // `waitUntil: 'load'` hangs for the full timeout on a bfcache restore.
    // Resolving on commit returns as soon as the navigation lands; the next
    // waitForSelector confirms #firstHeading is present.
    {
      const r = await timeAction(() => page.goBack({ waitUntil: 'commit' }) as Promise<unknown>);
      results.push({ index: baseIdx + 9, type: 'goBack', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 10. Wait for #firstHeading on the previous page
    {
      const r = await timeAction(() => page.waitForSelector(FIRST_HEADING));
      results.push({ index: baseIdx + 10, type: 'waitForSelector', durationMs: r.durationMs, success: r.success, error: r.error });
    }
  }
}

/** One provider instance per participant, reused across that provider's sessions. */
const providerCache = new Map<string, any>();

export const task = defineTask<ThroughputProviderConfig>(async (ctx) => {
  const { participant, taskIndex, step, measure } = ctx;
  const timeout = participant.timeout ?? 120_000;
  const sessionCreateOptions = participant.sessionCreateOptions ?? {};

  let provider = providerCache.get(participant.name);
  if (!provider) {
    provider = participant.createBrowserProvider();
    providerCache.set(participant.name, provider);
  }

  const navigateUrl = navUrlForIteration(taskIndex);
  const totalStart = performance.now();
  const actions: ActionResult[] = [];
  let createMs = 0;
  let connectMs = 0;
  let releaseMs = 0;
  let taskMs = 0;
  let actionsCompleted = 0;
  let actionsPerSecond = 0;

  let session: { sessionId: string; connectUrl: string } | undefined;
  let browser: Browser | undefined;
  let iterationError: string | undefined;

  try {
    const createStart = performance.now();
    session = await step('create', () =>
      withTimeout(
        provider.session.create(sessionCreateOptions),
        timeout,
        'Session creation timed out',
      ),
    ) as { sessionId: string; connectUrl: string };
    createMs = performance.now() - createStart;

    const connectStart = performance.now();
    const page = await step('connect', async () => {
      browser = await withTimeout(
        chromium.connectOverCDP(session!.connectUrl),
        30_000,
        'CDP connection timed out',
      );
      const [context] = browser.contexts();
      if (!context) throw new Error('No default browser context found');
      const [existingPage] = context.pages();
      return existingPage ?? (await context.newPage());
    });
    connectMs = performance.now() - connectStart;

    // Individual action failures are recorded but do not abort the session.
    // Throughput is a rate the step latency can't express, so report it as step
    // data via `measure`.
    await step('actions', async () => {
      await runActionLoop(page, actions, navigateUrl);
      taskMs = actions.reduce((sum, a) => sum + a.durationMs, 0);
      actionsCompleted = actions.filter((a) => a.success).length;
      actionsPerSecond = taskMs > 0 ? actionsCompleted / (taskMs / 1000) : 0;
      measure({ actionsPerSecond, actionsCompleted });
    });
  } catch (err) {
    iterationError = err instanceof Error ? err.message : String(err);
  } finally {
    if (browser) {
      await browser.close().catch(() => { });
    }
    if (session) {
      const releaseStart = performance.now();
      try {
        await step(
          'release',
          () =>
            withTimeout(
              provider.session.destroy(session!.sessionId),
              15_000,
              'Session destroy timed out',
            ),
          { reportConcurrency: false },
        );
      } catch {
        // Swallow release errors — they're recorded via releaseMs but should
        // not mask the more important action timings.
      }
      releaseMs = performance.now() - releaseStart;
    }
  }

  const data = {
    createMs,
    connectMs,
    releaseMs,
    totalMs: performance.now() - totalStart,
    taskMs,
    actionsCompleted,
    actionsPerSecond,
    actions: actions as unknown as JsonValue,
    ...(iterationError ? { errorMessage: iterationError } : {}),
  };

  // A session-level failure (create/connect/etc.) is a task error. Partial
  // action completion is NOT an error — it's a success record with
  // actionsCompleted < ACTIONS_PER_SESSION.
  if (iterationError) {
    throw new TaskError(iterationError, { code: 'THROUGHPUT_ERROR', data });
  }

  return { data };
});
