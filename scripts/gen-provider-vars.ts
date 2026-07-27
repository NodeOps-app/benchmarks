/**
 * Generate scripts/provider-vars.json: the authoritative map of which env vars
 * each provider benchmark needs, read straight from the `requiredEnvVars` field
 * on every provider config (the single source of truth in src\/**\/providers.ts).
 *
 * The vault envdef writer (write-vault-envdef.mjs) reads this to enumerate
 * ONLY a job's own secrets per run, passing them to `nsc vault export` instead
 * of revealing every secret in every job.
 *
 * Regenerate whenever providers change:  npx tsx scripts/gen-provider-vars.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { providers as sandboxProviders } from '../src/sandbox/providers.js';
import { browserProviders } from '../src/browser/providers.js';
import { throughputProviders } from '../src/browser/throughput-providers.js';
import { storageProviders } from '../src/storage/providers.js';
import { providers as scaleProviders } from '../src/scale/providers.js';
import { providers as aiGatewayProviders } from '../src/ai-gateway/providers.js';

type Cfg = { name: string; requiredEnvVars?: string[]; snapshotFork?: { requiredEnvVars?: string[] } };

const modes: Record<string, Cfg[]> = {
  sandbox: sandboxProviders as Cfg[],
  browser: browserProviders as Cfg[],
  throughput: throughputProviders as Cfg[],
  storage: storageProviders as Cfg[],
  scale: scaleProviders as Cfg[],
  'ai-gateway': aiGatewayProviders as Cfg[],
};

const manifest: Record<string, Record<string, string[]>> = {};
for (const [mode, configs] of Object.entries(modes)) {
  manifest[mode] = {};
  for (const c of configs) {
    // De-dupe and keep declared order.
    manifest[mode][c.name] = [...new Set(c.requiredEnvVars ?? [])];
  }
}

// snapshot-fork runs the storage providers but each needs its base creds PLUS
// the snapshotFork override vars (the *_SNAPSHOT_* keys). Its workflow passes
// `--mode snapshot-fork`, so expose it as its own manifest mode.
manifest['snapshot-fork'] = {};
for (const c of storageProviders as Cfg[]) {
  manifest['snapshot-fork'][c.name] = [
    ...new Set([...(c.requiredEnvVars ?? []), ...(c.snapshotFork?.requiredEnvVars ?? [])]),
  ];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, 'provider-vars.json');
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');

const counts = Object.entries(manifest)
  .map(([m, p]) => `${m}:${Object.keys(p).length}`)
  .join('  ');
console.error(`Wrote ${out}\n  providers per mode -> ${counts}`);
