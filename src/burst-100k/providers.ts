import { e2b } from '@computesdk/e2b';
import type { BurstProviderConfig } from './types.js';

/**
 * Providers opted into the 100k burst benchmark.
 *
 * A provider participates iff it has an entry here. This mirrors the
 * convention in src/sandbox/providers.ts; presence is the opt-in signal.
 */
export const providers: BurstProviderConfig[] = [
  {
    name: 'e2b',
    requiredEnvVars: ['E2B_API_KEY'],
    createCompute: () => e2b({ apiKey: process.env.E2B_API_KEY! }),
    concurrencyTarget: 100_000,
    rampSeconds: 60,
    perRequestTimeoutMs: 120_000,
    // timeoutMs auto-destroys sandbox after this duration; avoids leaking
    // 100k live sandboxes if we don't explicitly destroy each one.
    sandboxOptions: { timeoutMs: 60_000 },
  },
];

export function getProvider(name: string): BurstProviderConfig {
  const found = providers.find(p => p.name === name);
  if (!found) {
    const available = providers.map(p => p.name).join(', ');
    throw new Error(`Provider not opted in: ${name}. Available: ${available}`);
  }
  return found;
}
